import { describe, expect, it } from 'vitest';
import type { StatementResponse } from '../interactions/customerInteraction.js';
import { StatementInteractionMT940 } from '../interactions/statementInteractionMT940.js';
import type { Message } from '../message.js';

const MT940 =
	':20:RAW123\r\n' +
	':25:10020030/1234567\r\n' +
	':28C:1/1\r\n' +
	':60F:C260101EUR100,00\r\n' +
	':61:2601020102DR10,NDDTNONREF//BANKREF\r\n' +
	':86:105?00LASTSCHRIFT?20Test\r\n' +
	':62F:C260102EUR90,00\r\n';

describe('StatementInteractionMT940', () => {
	it('retains the original MT940 stream before parsing', () => {
		const interaction = new StatementInteractionMT940('1234567');
		const message = {
			findAllSegments: () => [{ bookedTransactions: MT940 }],
		} as unknown as Message;
		const response = { statements: [] } as unknown as StatementResponse;

		interaction.handleResponse(message, response);

		expect(response.rawMT940Data).toBe(MT940);
		expect(response.statements).toHaveLength(1);
		expect(response.statements[0].transactions).toHaveLength(1);
	});
});
