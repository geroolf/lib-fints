import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readBankingState, writeBankingState } from './banking-state.mjs';

const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
	);
});

async function statePath() {
	const directory = await mkdtemp(join(tmpdir(), 'lib-fints-state-test-'));
	temporaryDirectories.push(directory);
	const privateDirectory = join(directory, 'private');
	await mkdir(privateDirectory, { mode: 0o700 });
	return join(privateDirectory, 'commerzbank.json');
}

describe('banking state store', () => {
	it('writes and reads an owner-only state without credentials', async () => {
		const path = await statePath();
		await writeBankingState(path, {
			bank: 'commerzbank',
			bankingInformation: { systemId: 'SYSTEM-1', bankMessages: [] },
			tanMethodId: 902,
			tanMediaName: 'photoTAN',
			pin: 'must-not-be-written',
		});

		const stored = JSON.parse(await readFile(path, 'utf8'));
		expect(stored).not.toHaveProperty('pin');
		expect(stored.bankingInformation.systemId).toBe('SYSTEM-1');
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
		expect(await readBankingState(path, 'commerzbank')).toMatchObject({
			bank: 'commerzbank',
			tanMethodId: 902,
			tanMediaName: 'photoTAN',
		});
	});

	it('returns undefined for a missing state', async () => {
		expect(await readBankingState(await statePath(), 'commerzbank')).toBeUndefined();
	});

	it('rejects invalid JSON and a state for another bank', async () => {
		const invalidPath = await statePath();
		await writeFile(invalidPath, '{not-json', { mode: 0o600 });
		await expect(readBankingState(invalidPath, 'commerzbank')).rejects.toThrow(
			'Banking state is not valid JSON',
		);

		const wrongBankPath = await statePath();
		await writeBankingState(wrongBankPath, {
			bank: 'ing',
			bankingInformation: { systemId: 'SYSTEM-2', bankMessages: [] },
		});
		await expect(readBankingState(wrongBankPath, 'commerzbank')).rejects.toThrow(
			"Banking state belongs to 'ing'",
		);
	});
});
