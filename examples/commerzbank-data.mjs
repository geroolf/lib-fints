import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { FinTSClient, FinTSConfig, StatementFormat } from '../dist/index.js';
import { readBankingState, writeBankingState } from './lib/banking-state.mjs';

const COMMERZBANK_FINTS_URL = 'https://fints.commerzbank.de/fints';
const PRODUCT_VERSION = '1.0';
const STATE_BANK = 'commerzbank';

const rl = createInterface({ input, output });

class TanRequiredError extends Error {}

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

function optionalPositiveIntegerEnvironmentVariable(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		return undefined;
	}
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return Number(value);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function enabledEnvironmentFlag(name) {
	return process.env[name]?.trim() === '1';
}

function statementFormatEnvironmentVariable() {
	const value = process.env.COMMERZBANK_STATEMENT_FORMAT?.trim().toLowerCase() || 'auto';
	if (!['auto', 'camt', 'mt940'].includes(value)) {
		throw new Error('COMMERZBANK_STATEMENT_FORMAT must be auto, camt, or mt940');
	}
	return value;
}

function statementParameters(config, transactionId) {
	const parameters = config.getTransactionParameters(transactionId);
	if (!parameters) {
		return undefined;
	}

	return {
		maxDays: parameters.maxDays,
		entryCountAllowed: parameters.entryCountAllowed ?? parameters.maxEntryCountAllowed ?? undefined,
		allAccountsAllowed: parameters.allAccountsAllowed,
		supportedCamtFormats: parameters.supportedCamtFormats,
	};
}

function electronicStatementParameters(config) {
	const parameters = config.getTransactionParameters('HKEKA');
	if (!parameters) {
		return undefined;
	}

	return {
		indexAllowed: parameters.indexAllowed,
		receiptRequired: parameters.receiptRequired,
		maxEntryCountAllowed: parameters.maxEntryCountAllowed,
		supportedFormats: parameters.supportedFormats,
	};
}

function electronicStatementExtension(format) {
	switch (format) {
		case StatementFormat.PDF:
			return 'pdf';
		case StatementFormat.MT940:
			return 'mt940';
		default:
			return 'bin';
	}
}

function tanImageExtension(mimeType) {
	switch (mimeType.toLowerCase()) {
		case 'image/jpeg':
			return 'jpg';
		case 'image/gif':
			return 'gif';
		case 'image/svg+xml':
			return 'svg';
		default:
			return 'png';
	}
}

async function saveTanPhoto(photo) {
	const directory = await mkdtemp(join(tmpdir(), 'commerzbank-fints-'));
	const path = join(directory, `photo-tan.${tanImageExtension(photo.mimeType)}`);
	await writeFile(path, photo.image, { mode: 0o600 });
	return { directory, path };
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
	if (enabledEnvironmentFlag('FINTS_NONINTERACTIVE')) {
		throw new TanRequiredError(`${operation} requires manual TAN approval`);
	}

	if (!response.tanReference) {
		throw new Error(`${operation} requires approval but returned no TAN reference`);
	}

	const method = client.config.selectedTanMethod;
	let tanPhoto;
	try {
		console.log(`\n${response.tanChallenge || `${operation} requires approval.`}`);
		if (response.tanPhoto) {
			tanPhoto = await saveTanPhoto(response.tanPhoto);
			console.log(`photoTAN challenge image: ${tanPhoto.path}`);
		}

		if (!method?.isDecoupled) {
			const tan = (await rl.question('TAN: ')).trim();
			if (!tan) {
				throw new Error('A TAN is required');
			}
			const completed = await continueWithTan(response.tanReference, tan);
			assertSuccessful(completed, operation);
			return completed;
		}

		await rl.question('Approve the request in the photoTAN app, then press Enter here.');
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
	} finally {
		if (tanPhoto) {
			await rm(tanPhoto.directory, { recursive: true, force: true });
		}
	}
}

function rethrowTanRequired(error) {
	if (error instanceof TanRequiredError) {
		throw error;
	}
}

async function persistBankingState(path, config) {
	if (!path) {
		return;
	}
	await writeBankingState(path, {
		bank: STATE_BANK,
		bankingInformation: config.bankingInformation,
		tanMethodId: config.tanMethodId,
		tanMediaName: config.tanMediaName,
	});
}

async function fetchAccountData(
	client,
	account,
	from,
	to,
	transactionsOnly,
	statementFormat,
	includeRawMt940,
) {
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
		portfolioSupported: client.canGetPortfolio(account.accountNumber),
		creditCardStatementsSupported: client.canGetCreditCardStatements(account.accountNumber),
		statementFormats: {
			camt: transactionIds.includes('HKCAZ'),
			mt940: transactionIds.includes('HKKAZ'),
		},
	};

	if (result.statementsSupported) {
		console.log(
			`Fetching ${statementFormat === 'auto' ? '' : `${statementFormat.toUpperCase()} `}transactions for ${account.product || account.accountType} ending in ${ending}...`,
		);
		try {
			let response = await client.getAccountStatements(
				account.accountNumber,
				from,
				to,
				statementFormat !== 'mt940',
			);
			response = await finishTan(client, response, 'Transaction retrieval', (reference, tan) =>
				client.getAccountStatementsWithTan(reference, tan),
			);
			result.statements = response.statements.map((statement) => ({
				...statement,
				account: statement.account ? `...${statement.account.slice(-4)}` : undefined,
			}));
			if (includeRawMt940) {
				result.rawMT940Data = response.rawMT940Data;
			}
		} catch (error) {
			rethrowTanRequired(error);
			result.statementsError = errorMessage(error);
		}
	}

	if (result.balanceSupported && !transactionsOnly) {
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
			rethrowTanRequired(error);
			result.balanceError = errorMessage(error);
		}
	}

	if (result.creditCardStatementsSupported && !transactionsOnly) {
		console.log(`Fetching card transactions for account ending in ${ending}...`);
		try {
			let response = await client.getCreditCardStatements(account.accountNumber, from);
			response = await finishTan(client, response, 'Card transaction retrieval', (reference, tan) =>
				client.getCreditCardStatementsWithTan(reference, tan),
			);
			result.creditCardStatements = response.statements.map((statement) => ({
				...statement,
				account: statement.account ? `...${statement.account.slice(-4)}` : undefined,
			}));
		} catch (error) {
			rethrowTanRequired(error);
			result.creditCardStatementsError = errorMessage(error);
		}
	}

	if (result.portfolioSupported && !transactionsOnly) {
		console.log(`Fetching portfolio for depot ending in ${ending}...`);
		try {
			// Some banks reject HKWPD when its optional output currency is explicitly set.
			let response = await client.getPortfolio(account.accountNumber);
			response = await finishTan(client, response, 'Portfolio retrieval', (reference, tan) =>
				client.getPortfolioWithTan(reference, tan),
			);
			result.portfolio = response.portfolioStatement;
			result.rawMT535Data = response.rawMT535Data;
		} catch (error) {
			rethrowTanRequired(error);
			result.portfolioError = errorMessage(error);
		}
	}

	return result;
}

async function fetchElectronicStatementData(client, account, directory, options) {
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
		electronicStatementsSupported: client.canGetElectronicStatements(account.accountNumber),
	};

	if (!result.electronicStatementsSupported) {
		result.electronicStatementsError = 'The selected account does not advertise HKEKA';
		return result;
	}

	console.log(`Fetching one electronic statement for account ending in ${ending}...`);
	try {
		let response = await client.getElectronicStatements(account.accountNumber, options);
		response = await finishTan(
			client,
			response,
			'Electronic statement retrieval',
			(reference, tan) => client.getElectronicStatementsWithTan(reference, tan),
		);

		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		result.electronicStatements = [];
		for (const [index, statement] of response.statements.entries()) {
			const year = statement.year ?? options.year ?? 'unknown-year';
			const number = statement.number ?? options.number ?? index + 1;
			const extension = electronicStatementExtension(statement.format);
			const filename = `commerzbank-${ending}-statement-${year}-${number}-${index + 1}.${extension}`;
			const path = join(directory, filename);
			await writeFile(path, statement.document, { mode: 0o600 });
			await chmod(path, 0o600);
			result.electronicStatements.push({
				format: statement.format,
				from: statement.from,
				to: statement.to,
				date: statement.date,
				year: statement.year,
				number: statement.number,
				file: path,
				bytes: statement.document.byteLength,
				receiptProvided: Boolean(statement.receipt),
			});
		}
		result.moreElectronicStatementsAvailable = Boolean(response.nextOffset);
	} catch (error) {
		rethrowTanRequired(error);
		result.electronicStatementsError = errorMessage(error);
	}

	return result;
}

async function main() {
	const productId = requiredEnvironmentVariable('FINTS_PRODUCT_ID');
	const bankId = requiredEnvironmentVariable('COMMERZBANK_BANK_ID');
	const userId = requiredEnvironmentVariable('COMMERZBANK_USER_ID');
	const pin = requiredEnvironmentVariable('COMMERZBANK_PIN');
	const customerId = process.env.COMMERZBANK_CUSTOMER_ID?.trim() || undefined;
	const stateFile = process.env.COMMERZBANK_STATE_FILE?.trim() || undefined;
	const forceSynchronization = enabledEnvironmentFlag('COMMERZBANK_FORCE_SYNC');
	const accountEnding = process.env.COMMERZBANK_ACCOUNT_ENDING?.trim() || undefined;
	const transactionsOnly = enabledEnvironmentFlag('COMMERZBANK_TRANSACTIONS_ONLY');
	const electronicStatementsOnly = enabledEnvironmentFlag('COMMERZBANK_ELECTRONIC_STATEMENTS_ONLY');
	const includeRawMt940 = enabledEnvironmentFlag('COMMERZBANK_INCLUDE_RAW_MT940');
	const requestedStatementFormat = statementFormatEnvironmentVariable();
	const electronicStatementDirectory = process.env.COMMERZBANK_STATEMENT_DIR?.trim();
	const electronicStatementYear = optionalPositiveIntegerEnvironmentVariable(
		'COMMERZBANK_STATEMENT_YEAR',
	);
	const electronicStatementNumber = optionalPositiveIntegerEnvironmentVariable(
		'COMMERZBANK_STATEMENT_NUMBER',
	);
	const from = optionalDateEnvironmentVariable('COMMERZBANK_FROM');
	const to = optionalDateEnvironmentVariable('COMMERZBANK_TO');
	if (!/^[A-Z0-9]{25}$/.test(productId)) {
		throw new Error('FINTS_PRODUCT_ID must contain exactly 25 uppercase letters or digits');
	}
	if (!/^\d{8}$/.test(bankId)) {
		throw new Error('COMMERZBANK_BANK_ID must be the 8-digit BLZ for this account');
	}
	if (accountEnding && !/^\d{4}$/.test(accountEnding)) {
		throw new Error('COMMERZBANK_ACCOUNT_ENDING must contain exactly four digits');
	}
	if (includeRawMt940 && requestedStatementFormat !== 'mt940') {
		throw new Error('COMMERZBANK_INCLUDE_RAW_MT940=1 requires COMMERZBANK_STATEMENT_FORMAT=mt940');
	}
	if (includeRawMt940 && !process.env.COMMERZBANK_OUTPUT) {
		throw new Error(
			'COMMERZBANK_INCLUDE_RAW_MT940=1 requires an owner-only COMMERZBANK_OUTPUT file',
		);
	}
	if (electronicStatementsOnly && transactionsOnly) {
		throw new Error(
			'COMMERZBANK_ELECTRONIC_STATEMENTS_ONLY and COMMERZBANK_TRANSACTIONS_ONLY are mutually exclusive',
		);
	}
	if (electronicStatementsOnly && !electronicStatementDirectory) {
		throw new Error('COMMERZBANK_ELECTRONIC_STATEMENTS_ONLY=1 requires COMMERZBANK_STATEMENT_DIR');
	}
	if (electronicStatementsOnly && !process.env.COMMERZBANK_OUTPUT) {
		throw new Error(
			'COMMERZBANK_ELECTRONIC_STATEMENTS_ONLY=1 requires an owner-only COMMERZBANK_OUTPUT file',
		);
	}
	if (Boolean(electronicStatementYear) !== Boolean(electronicStatementNumber)) {
		throw new Error(
			'COMMERZBANK_STATEMENT_YEAR and COMMERZBANK_STATEMENT_NUMBER must be provided together',
		);
	}
	if (from && to && from > to) {
		throw new Error('COMMERZBANK_FROM must not be after COMMERZBANK_TO');
	}

	const storedState = stateFile ? await readBankingState(stateFile, STATE_BANK) : undefined;
	const config = storedState
		? FinTSConfig.fromBankingInformation(
				productId,
				PRODUCT_VERSION,
				storedState.bankingInformation,
				userId,
				pin,
				storedState.tanMethodId,
				storedState.tanMediaName,
				customerId,
			)
		: FinTSConfig.forFirstTimeUse(
				productId,
				PRODUCT_VERSION,
				COMMERZBANK_FINTS_URL,
				bankId,
				userId,
				pin,
				customerId,
			);
	config.debugEnabled = process.env.FINTS_DEBUG === '1';
	const client = new FinTSClient(config);

	if (!storedState) {
		console.log('Synchronizing Commerzbank FinTS capabilities for first-time setup...');
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
			throw new Error(
				'Commerzbank returned no selectable TAN methods. Check that HBCI PIN/TAN access and photoTAN are active.',
			);
		}

		const tanMethod = await choose(
			tanMethods,
			'Select TAN method number',
			(method) => `${method.name}${method.isDecoupled ? ' (app approval)' : ''}`,
			process.env.COMMERZBANK_TAN_METHOD_ID,
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
			if (process.env.COMMERZBANK_TAN_MEDIA) {
				const index = tanMedia.indexOf(process.env.COMMERZBANK_TAN_MEDIA);
				if (index < 0) {
					throw new Error(
						`COMMERZBANK_TAN_MEDIA '${process.env.COMMERZBANK_TAN_MEDIA}' is not available`,
					);
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
		await persistBankingState(stateFile, config);
		if (stateFile) {
			console.log(`Saved reusable Commerzbank synchronization state to ${stateFile}`);
		}
	} else if (forceSynchronization) {
		console.log('Refreshing saved Commerzbank FinTS capabilities...');
		let sync = await client.synchronize();
		sync = await finishTan(client, sync, 'Synchronization', (reference, tan) =>
			client.synchronizeWithTan(reference, tan),
		);
		assertSuccessful(sync, 'Synchronization');
		await persistBankingState(stateFile, config);
	} else {
		console.log('Using saved Commerzbank FinTS synchronization state.');
	}

	const accounts = config.bankingInformation.upd?.bankAccounts ?? [];
	if (accounts.length === 0) {
		throw new Error('Commerzbank returned no accounts after synchronization');
	}
	const selectedAccounts = accountEnding
		? accounts.filter((account) => account.accountNumber.endsWith(accountEnding))
		: accounts;
	if (selectedAccounts.length === 0) {
		throw new Error(`Commerzbank returned no account ending in ${accountEnding}`);
	}
	if (accountEnding && selectedAccounts.length > 1) {
		throw new Error(
			`Commerzbank returned more than one account ending in ${accountEnding}; the filter is ambiguous`,
		);
	}
	const requiredStatementTransaction =
		requestedStatementFormat === 'camt'
			? 'HKCAZ'
			: requestedStatementFormat === 'mt940'
				? 'HKKAZ'
				: undefined;
	if (
		requiredStatementTransaction &&
		selectedAccounts.some(
			(account) =>
				!account.allowedTransactions?.some(
					(transaction) => transaction.transId === requiredStatementTransaction,
				),
		)
	) {
		throw new Error(
			`The selected account does not advertise ${requestedStatementFormat.toUpperCase()} transaction retrieval`,
		);
	}

	const camtStatementParameters = statementParameters(config, 'HKCAZ');
	const mt940StatementParameters = statementParameters(config, 'HKKAZ');
	const eStatementParameters = electronicStatementParameters(config);
	if (electronicStatementsOnly && electronicStatementYear && !eStatementParameters?.indexAllowed) {
		throw new Error(
			'Commerzbank does not allow selecting an electronic statement by year and number',
		);
	}
	if (electronicStatementsOnly && eStatementParameters) {
		console.log(
			`Commerzbank electronic statements: formats ${eStatementParameters.supportedFormats?.join(', ') || 'unknown'}, indexed selection ${eStatementParameters.indexAllowed ? 'allowed' : 'not allowed'}, receipt ${eStatementParameters.receiptRequired ? 'required' : 'not required'}.`,
		);
	}
	const useCamt =
		requestedStatementFormat === 'camt' ||
		(requestedStatementFormat === 'auto' &&
			selectedAccounts.some((account) =>
				account.allowedTransactions?.some((transaction) => transaction.transId === 'HKCAZ'),
			));
	const effectiveStatementFormat = useCamt ? 'camt' : 'mt940';
	const advertisedMaxDays = useCamt
		? camtStatementParameters?.maxDays
		: mt940StatementParameters?.maxDays;
	if (advertisedMaxDays) {
		console.log(
			`Commerzbank advertises a maximum ${effectiveStatementFormat.toUpperCase()} transaction lookback of ${advertisedMaxDays} days.`,
		);
	}

	const accountData = [];
	for (const account of selectedAccounts) {
		if (electronicStatementsOnly) {
			const supportedFormats = eStatementParameters?.supportedFormats ?? [];
			const format = supportedFormats.includes(StatementFormat.PDF)
				? StatementFormat.PDF
				: supportedFormats[0];
			accountData.push(
				await fetchElectronicStatementData(client, account, electronicStatementDirectory, {
					format,
					year: electronicStatementYear,
					number: electronicStatementNumber,
					maxEntries: eStatementParameters?.maxEntryCountAllowed ? 1 : undefined,
				}),
			);
		} else {
			accountData.push(
				await fetchAccountData(
					client,
					account,
					from,
					to,
					transactionsOnly,
					effectiveStatementFormat,
					includeRawMt940,
				),
			);
		}
	}
	await persistBankingState(stateFile, config);

	const result = {
		fetchedAt: new Date().toISOString(),
		requestedStatementPeriod: {
			from: from?.toISOString().slice(0, 10),
			to: to?.toISOString().slice(0, 10),
		},
		accountFilterEnding: accountEnding,
		usedSavedBankingState: Boolean(storedState),
		transactionsOnly,
		electronicStatementsOnly,
		includesRawMt940: includeRawMt940,
		requestedStatementFormat,
		effectiveStatementFormat,
		bank: {
			name: config.bankingInformation.bpd?.bankName,
			bankId: config.bankId,
			statementParameters: {
				camt: camtStatementParameters,
				mt940: mt940StatementParameters,
				electronicStatements: eStatementParameters,
			},
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
	};

	const json = `${JSON.stringify(result, null, 2)}\n`;
	if (process.env.COMMERZBANK_OUTPUT) {
		await writeFile(process.env.COMMERZBANK_OUTPUT, json, { mode: 0o600 });
		await chmod(process.env.COMMERZBANK_OUTPUT, 0o600);
		console.log(`Commerzbank data written to ${process.env.COMMERZBANK_OUTPUT}`);
	} else {
		console.log(json);
	}
}

try {
	await main();
} catch (error) {
	if (error instanceof TanRequiredError) {
		console.error(`TAN_REQUIRED: ${error.message}`);
		process.exitCode = 75;
	} else {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
} finally {
	rl.close();
}
