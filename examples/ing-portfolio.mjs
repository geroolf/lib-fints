import { chmod, writeFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { FinTSClient, FinTSConfig } from '../dist/index.js';

const ING_FINTS_URL = 'https://fints.ing.de/fints/';
const ING_BANK_ID = '50010517';
const PRODUCT_VERSION = '1.0';

const rl = createInterface({ input, output });

function requiredEnvironmentVariable(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function bankAnswers(response) {
	return response.bankAnswers.map((answer) => `${answer.code}: ${answer.text}`).join('\n');
}

function assertSuccessful(response, operation) {
	if (!response.success) {
		throw new Error(`${operation} failed:\n${bankAnswers(response)}`);
	}
}

function optionalDateEnvironmentVariable(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		return undefined;
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error(`${name} must use YYYY-MM-DD format`);
	}
	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
		throw new Error(`${name} is not a valid calendar date`);
	}
	return date;
}

function optionalAccountEndingEnvironmentVariable(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		return undefined;
	}
	if (!/^\d{4}$/.test(value)) {
		throw new Error(`${name} must contain exactly four digits`);
	}
	return value;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

async function choose(items, prompt, render, environmentValue) {
	if (environmentValue) {
		const requested = environmentValue.trim();
		const match = items.find((item) => String(item.id) === requested);
		if (!match) {
			throw new Error(`Configured selection '${requested}' is not available`);
		}
		return match;
	}

	if (items.length === 1) {
		return items[0];
	}

	for (const item of items) {
		console.log(`  ${item.id}: ${render(item)}`);
	}

	const answer = await rl.question(`${prompt}: `);
	const match = items.find((item) => String(item.id) === answer.trim());
	if (!match) {
		throw new Error(`Selection '${answer.trim()}' is not available`);
	}
	return match;
}

async function finishTan(client, response, operation, continueWithTan) {
	assertSuccessful(response, operation);
	if (!response.requiresTan) {
		return response;
	}

	if (!response.tanReference) {
		throw new Error(`${operation} requires approval but returned no TAN reference`);
	}

	const method = client.config.selectedTanMethod;
	console.log(`\n${response.tanChallenge || `${operation} requires approval.`}`);

	if (!method?.isDecoupled) {
		const tan = (await rl.question('TAN: ')).trim();
		if (!tan) {
			throw new Error('A TAN is required');
		}
		const completed = await continueWithTan(response.tanReference, tan);
		assertSuccessful(completed, operation);
		return completed;
	}

	await rl.question('Approve the request in the ING app, then press Enter here.');
	const maximumAttempts = method.decoupled?.maxStatusRequests || 10;
	const waitSeconds = method.decoupled?.waitingSecondsBetweenStatusRequests || 3;

	let current = response;
	for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
		current = await continueWithTan(current.tanReference || response.tanReference);
		assertSuccessful(current, operation);
		if (!current.requiresTan) {
			return current;
		}
		if (attempt < maximumAttempts) {
			await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
		}
	}

	throw new Error(`${operation} was not approved after ${maximumAttempts} status checks`);
}

async function fetchAccountData(client, account, from, to) {
	const ending = account.accountNumber.slice(-4);
	const transactionIds =
		account.allowedTransactions?.map((transaction) => transaction.transId).sort() ?? [];
	const result = {
		accountNumberEnding: ending,
		ibanEnding: account.iban?.slice(-4),
		product: account.product,
		accountType: account.accountType,
		currency: account.currency,
		capabilities: transactionIds,
		portfolioTransactionsAdvertised: transactionIds.includes('HKWDU'),
		balanceSupported: client.canGetAccountBalance(account.accountNumber),
		statementsSupported: client.canGetAccountStatements(account.accountNumber),
		statementFormats: {
			camt: transactionIds.includes('HKCAZ'),
			mt940: transactionIds.includes('HKKAZ'),
		},
		balance: undefined,
		balanceError: undefined,
		statements: undefined,
		statementsError: undefined,
	};

	if (result.statementsSupported) {
		console.log(
			`Fetching transactions for ${account.product || account.accountType} ending in ${ending}...`,
		);
		try {
			let response = await client.getAccountStatements(account.accountNumber, from, to);
			response = await finishTan(client, response, 'Transaction retrieval', (reference, tan) =>
				client.getAccountStatementsWithTan(reference, tan),
			);
			result.statements = response.statements.map((statement) => ({
				...statement,
				account: statement.account ? `...${statement.account.slice(-4)}` : undefined,
			}));
		} catch (error) {
			result.statementsError = errorMessage(error);
		}
	}

	if (result.balanceSupported) {
		console.log(
			`Fetching balance for ${account.product || account.accountType} ending in ${ending}...`,
		);
		try {
			let response = await client.getAccountBalance(account.accountNumber);
			response = await finishTan(client, response, 'Balance retrieval', (reference, tan) =>
				client.getAccountBalanceWithTan(reference, tan),
			);
			result.balance = response.balance;
		} catch (error) {
			result.balanceError = errorMessage(error);
		}
	}

	return result;
}

async function main() {
	const productId = requiredEnvironmentVariable('FINTS_PRODUCT_ID');
	const userId = requiredEnvironmentVariable('ING_USER_ID');
	const pin = requiredEnvironmentVariable('ING_PIN');
	const depotEnding = optionalAccountEndingEnvironmentVariable('ING_DEPOT_ENDING');
	const accountEnding = optionalAccountEndingEnvironmentVariable('ING_ACCOUNT_ENDING');
	const from = optionalDateEnvironmentVariable('ING_FROM');
	const to = optionalDateEnvironmentVariable('ING_TO');
	if (!/^[A-Z0-9]{25}$/.test(productId)) {
		throw new Error('FINTS_PRODUCT_ID must contain exactly 25 uppercase letters or digits');
	}
	if (from && to && from > to) {
		throw new Error('ING_FROM must not be after ING_TO');
	}

	const config = FinTSConfig.forFirstTimeUse(
		productId,
		PRODUCT_VERSION,
		ING_FINTS_URL,
		ING_BANK_ID,
		userId,
		pin,
	);
	config.debugEnabled = process.env.FINTS_DEBUG === '1';
	const client = new FinTSClient(config);

	console.log('Synchronizing ING FinTS capabilities...');
	const firstSync = await client.synchronize();
	assertSuccessful(firstSync, 'Initial synchronization');
	if (firstSync.requiresTan) {
		throw new Error(
			'The initial synchronization unexpectedly requested a TAN before TAN selection',
		);
	}

	const tanMethods = config.availableTanMethods.map((method) => ({
		...method,
		id: method.id,
	}));
	if (tanMethods.length === 0) {
		throw new Error('ING returned no selectable TAN methods');
	}

	const tanMethod = await choose(
		tanMethods,
		'Select TAN method number',
		(method) => `${method.name}${method.isDecoupled ? ' (app approval)' : ''}`,
		process.env.ING_TAN_METHOD_ID,
	);
	client.selectTanMethod(tanMethod.id);

	let sync = await client.synchronize();
	sync = await finishTan(client, sync, 'Synchronization', (reference, tan) =>
		client.synchronizeWithTan(reference, tan),
	);
	assertSuccessful(sync, 'Synchronization');

	const selectedMethod = config.selectedTanMethod;
	const tanMedia = selectedMethod?.activeTanMedia ?? [];
	if (tanMedia.length > 0) {
		const mediaChoices = tanMedia.map((name, index) => ({ id: index + 1, name }));
		let requestedMedia;
		if (process.env.ING_TAN_MEDIA) {
			const index = tanMedia.indexOf(process.env.ING_TAN_MEDIA);
			if (index < 0) {
				throw new Error(`ING_TAN_MEDIA '${process.env.ING_TAN_MEDIA}' is not available`);
			}
			requestedMedia = String(index + 1);
		}
		const media = await choose(
			mediaChoices,
			'Select TAN medium number',
			(item) => item.name,
			requestedMedia,
		);
		client.selectTanMedia(media.name);
	}

	const accounts = config.bankingInformation.upd?.bankAccounts ?? [];
	if (accounts.length === 0) {
		throw new Error('ING returned no accounts after synchronization');
	}

	const depotAccounts = accounts
		.filter((account) => client.canGetPortfolio(account.accountNumber))
		.filter((account) => !depotEnding || account.accountNumber.endsWith(depotEnding))
		.map((account, index) => ({ id: index + 1, account }));

	if (depotAccounts.length === 0) {
		const summary = accounts
			.map(
				(account) =>
					`${account.product || account.accountType} (...${account.accountNumber.slice(-4)}): ${
						account.allowedTransactions?.map((transaction) => transaction.transId).join(', ') ||
						'no advertised transactions'
					}`,
			)
			.join('\n');
		const filterMessage = depotEnding ? ` ending in ${depotEnding}` : '';
		throw new Error(
			`ING returned no account${filterMessage} supporting HKWPD portfolio retrieval.\n${summary}`,
		);
	}

	if (depotEnding && depotAccounts.length > 1) {
		throw new Error(
			`ING returned more than one depot ending in ${depotEnding}; the filter is ambiguous`,
		);
	}

	const depot = await choose(
		depotAccounts,
		'Select depot number',
		(item) =>
			`${item.account.product || item.account.accountType} (...${item.account.accountNumber.slice(-4)})`,
		process.env.ING_DEPOT_INDEX,
	);

	console.log(`Fetching portfolio for depot ending in ${depot.account.accountNumber.slice(-4)}...`);
	// ING rejects HKWPD requests that explicitly set the optional output currency.
	let portfolio = await client.getPortfolio(depot.account.accountNumber);
	portfolio = await finishTan(client, portfolio, 'Portfolio retrieval', (reference, tan) =>
		client.getPortfolioWithTan(reference, tan),
	);
	assertSuccessful(portfolio, 'Portfolio retrieval');

	const selectedAccounts = accountEnding
		? accounts.filter((account) => account.accountNumber.endsWith(accountEnding))
		: accounts;
	if (selectedAccounts.length === 0) {
		throw new Error(`ING returned no account ending in ${accountEnding}`);
	}
	if (accountEnding && selectedAccounts.length > 1) {
		throw new Error(
			`ING returned more than one account ending in ${accountEnding}; the filter is ambiguous`,
		);
	}

	const accountData = [];
	for (const account of selectedAccounts) {
		accountData.push(await fetchAccountData(client, account, from, to));
	}

	const result = {
		fetchedAt: new Date().toISOString(),
		requestedStatementPeriod: {
			from: from?.toISOString().slice(0, 10),
			to: to?.toISOString().slice(0, 10),
		},
		accountFilterEnding: accountEnding,
		depotFilterEnding: depotEnding,
		bank: {
			name: config.bankingInformation.bpd?.bankName,
			bankId: config.bankId,
			capabilities:
				config.bankingInformation.bpd?.allowedTransactions
					.map((transaction) => ({
						id: transaction.transId,
						versions: transaction.versions,
						tanRequired: transaction.tanRequired,
					}))
					.sort((a, b) => a.id.localeCompare(b.id)) ?? [],
		},
		accounts: accountData,
		depot: {
			accountNumberEnding: depot.account.accountNumber.slice(-4),
			product: depot.account.product,
		},
		portfolio: portfolio.portfolioStatement,
		rawMT535Data: portfolio.rawMT535Data,
	};

	const json = `${JSON.stringify(result, null, 2)}\n`;
	if (process.env.ING_OUTPUT) {
		await writeFile(process.env.ING_OUTPUT, json, { mode: 0o600 });
		await chmod(process.env.ING_OUTPUT, 0o600);
		console.log(`ING data written to ${process.env.ING_OUTPUT}`);
	} else {
		console.log(json);
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	rl.close();
}
