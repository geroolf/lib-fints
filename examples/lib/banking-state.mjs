import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const STATE_SCHEMA_VERSION = 1;

function validateState(state, expectedBank) {
	if (!state || typeof state !== 'object' || Array.isArray(state)) {
		throw new Error('Banking state must be a JSON object');
	}
	if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
		throw new Error(`Unsupported banking state schema version: ${state.schemaVersion}`);
	}
	if (state.bank !== expectedBank) {
		throw new Error(`Banking state belongs to '${state.bank}', expected '${expectedBank}'`);
	}
	if (
		!state.bankingInformation ||
		typeof state.bankingInformation !== 'object' ||
		typeof state.bankingInformation.systemId !== 'string'
	) {
		throw new Error('Banking state contains no valid bankingInformation');
	}
	if (
		state.tanMethodId !== undefined &&
		(!Number.isInteger(state.tanMethodId) || state.tanMethodId < 1)
	) {
		throw new Error('Banking state contains no valid TAN method ID');
	}
	if (state.tanMediaName !== undefined && typeof state.tanMediaName !== 'string') {
		throw new Error('Banking state contains no valid TAN medium');
	}
	return state;
}

export async function readBankingState(path, expectedBank) {
	let raw;
	try {
		raw = await readFile(path, 'utf8');
	} catch (error) {
		if (error && typeof error === 'object' && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Banking state is not valid JSON: ${error.message}`);
	}
	await chmod(path, 0o600);
	return validateState(parsed, expectedBank);
}

export async function writeBankingState(
	path,
	{ bank, bankingInformation, tanMethodId, tanMediaName },
) {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);

	const state = validateState(
		{
			schemaVersion: STATE_SCHEMA_VERSION,
			bank,
			savedAt: new Date().toISOString(),
			bankingInformation,
			tanMethodId,
			tanMediaName,
		},
		bank,
	);
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let handle;
	try {
		handle = await open(temporaryPath, 'wx', 0o600);
		await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, path);
		await chmod(path, 0o600);
	} finally {
		await handle?.close();
		await rm(temporaryPath, { force: true });
	}
}
