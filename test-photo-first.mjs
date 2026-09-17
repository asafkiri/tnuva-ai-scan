import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { tnuvaPaperCheck, scanChecksumMismatches, scanConsensusDiff, scanConsensusDisputedRows, createServer } from './server.js';

const image = 'data:image/jpeg;base64,YQ==';
const catalog = [{ id: 'milk', name: 'חלב בדיקה', barcode: '7290000000008' }];
function row(overrides = {}) {
  return { sourcePage: 1, lineNumber: 1, section: 'items', code: '8', description: 'חלב בדיקה',
    quantity: 10, unitPriceExVat: 5, lineTotalExVat: 50, promoStar: false, confidence: .95, ...overrides };
}
function doc(overrides = {}) {
  return { noteIndex: 0, docNumber: 'TEST', docType: 'invoice', docDate: '7.9.2026', pageCount: 1,
    vatPct: 18, itemsSectionTotalExVat: null, promoDiscountExVat: null, itemsPrintedLines: 1,
    returnsSectionTotalExVat: null, returnsPrintedLines: null, subtotalExVat: 50, vatAmount: 9,
    totalInclVat: 59, roundingDiff: null, confidence: .95, warnings: [], rows: [row()], ...overrides };
}
const scan = d => ({ documents: [d], warnings: [] });
const input = [{ noteIndex: 0, pages: [image], expectedSubtotalExVat: null, expectedLines: null }];

test('Tnuva paper proves net after separate promo discount and counts printed lines, not units', () => {
  assert.equal(tnuvaPaperCheck(doc(), 1).receivable, true);
  assert.deepEqual(scanChecksumMismatches(scan(doc()), input), []);
  assert.equal(tnuvaPaperCheck(doc({ promoDiscountExVat: 5, subtotalExVat: 45 }), 1).ok, true);
  assert.equal(tnuvaPaperCheck(doc({ promoDiscountExVat: 5 }), 1).ok, false);
  assert.equal(tnuvaPaperCheck(doc({ subtotalExVat: 49.99 }), 1).ok, false);
  assert.equal(tnuvaPaperCheck(doc({ itemsPrintedLines: 10 }), 1).ok, false);
  assert.equal(tnuvaPaperCheck(doc({ rows: [row({ quantity: null })] }), 1).ok, false);
  assert.equal(tnuvaPaperCheck(doc({ rows: [row({ lineTotalExVat: null })] }), 1).ok, false);
  assert.equal(tnuvaPaperCheck(doc({ rows: [row({ quantity: 1.25, unitPriceExVat: 40 })] }), 1).ok, true);
  assert.equal(tnuvaPaperCheck(doc({ subtotalExVat: 62.63, rows: [row({ quantity: 4, unitPriceExVat: 15.66, lineTotalExVat: 62.63 })] }), 1).ok, true, 'printed amount is not overwritten by unit-price multiplication');
  assert.equal(tnuvaPaperCheck(doc({ itemsPrintedLines: null }), 1).retryable, false);
  assert.equal(tnuvaPaperCheck(doc({ subtotalExVat: null }), 1).retryable, false);
  assert.equal(tnuvaPaperCheck(doc(), 2).ok, false);
});
test('mixed and credit documents are checked but never adopted as ordinary receiving', () => {
  const mixed = doc({ subtotalExVat: 40, returnsSectionTotalExVat: 10, returnsPrintedLines: 1,
    rows: [row(), row({ section: 'returns', quantity: 2, lineTotalExVat: 10 })] });
  const check = tnuvaPaperCheck(mixed, 1);
  assert.equal(check.ok, true); assert.equal(check.receivable, false); assert.equal(check.lines, 1);
  assert.equal(tnuvaPaperCheck(doc({ docType: 'credit', subtotalExVat: -50 }), 1).ok, true);
  assert.equal(tnuvaPaperCheck(doc({ docType: 'credit', subtotalExVat: -50 }), 1).receivable, false);
  assert.equal(tnuvaPaperCheck(doc({ docType: 'unknown' }), 1).receivable, false);
});
test('crates remain normal products; deposit money counts without becoming product units', () => {
  const d=doc({ subtotalExVat: 63.05, itemsPrintedLines: 3, rows: [row(),
    row({ description: 'ארגז', quantity: 1, unitPriceExVat: 10, lineTotalExVat: 10 }),
    row({ description: 'פיקדון', quantity: 10, unitPriceExVat: .305, lineTotalExVat: 3.05 })] });
  const check=tnuvaPaperCheck(d, 1); assert.equal(check.ok,true); assert.equal(check.units,11); assert.equal(check.lines,3);
});
test('legacy typed money and line anchors retain their two-agorot tolerance', () => {
  const anchor = amount => [{...input[0], expectedSubtotalExVat: amount, expectedLines: 1}];
  assert.equal(scanChecksumMismatches(scan(doc()),anchor(50.02)).length,0);
  assert.equal(scanChecksumMismatches(scan(doc()),anchor(50.03)).length,1);
  assert.equal(scanChecksumMismatches(scan(doc({promoDiscountExVat:5,subtotalExVat:45})),anchor(45)).length,0);
});

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = encode({ alg: 'RS256', kid: jwk.kid }) + '.' + encode({
  aud: 'tnuva-marketkiri-5d50d', iss: 'https://securetoken.google.com/tnuva-marketkiri-5d50d', sub: 'fixture', iat: now, exp: now + 3600 });
const token = unsigned + '.' + crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
async function request(responses, documents = input, extraEnv = {}) {
  const calls = [], logs = [];
  const server = createServer({ env: { OPENAI_API_KEY: 'fixture-only', OPENAI_MODEL: 'gpt-5.6-luna',
    OPENAI_RETRY_MODEL: 'gpt-5.6-terra', OPENAI_RETRY_SERVICE_TIER: 'priority', ...extraEnv },
    logger: { info: (...args) => logs.push(args), error: error => { throw error; } },
    fetchImpl: async (url, options) => {
      if (url.includes('googleapis.com')) return Response.json({ keys: [jwk] });
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const call = JSON.parse(options.body); calls.push(call);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, 'Unexpected paid model call');
      return Response.json({ ...next, model: call.model, id: 'test-' + calls.length,
        usage: { input_tokens: 10, output_tokens: 20 } });
    } });
  const output = await new Promise(resolve => {
    const req = Readable.from([Buffer.from(JSON.stringify({ documents, catalog }))]);
    req.method = 'POST'; req.url = '/scan'; req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { origin: 'https://asafkiri.github.io', authorization: 'Bearer ' + token };
    server.emit('request', req, { headersSent: false, writeHead() { this.headersSent = true; }, write() {}, end(body) { resolve(JSON.parse(body)); } });
  });
  server.close();
  return { output, calls, logs };
}
const answer = document => ({ output_text: JSON.stringify(scan(document)) });
// v11: כל סריקה יוצאת פעמיים במקביל למודל הזול, ולכן תרחיש שפעם צרך תשובה
// אחת צורך שתיים זהות. שתי תשובות זהות = הסכמה, בלי הסלמה.
const agreed = document => [answer(document), answer(document)];
test('normal photo: two parallel Luna reads agree and nothing escalates', async () => {
  const { output, calls, logs } = await request(agreed(doc()));
  assert.equal(output.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.model), ['gpt-5.6-luna', 'gpt-5.6-luna']);
  assert.equal(output.consensus.agreed, true);
  assert.equal(output.consensus.escalated, false);
  assert.deepEqual(output.consensus.disputedRows, []);
  assert.equal(output.checksumRetryAttempted, false);
  assert.equal(output.paperValidation[0].ok, true);
  assert.equal(output.scanAudit.attempts[0].model, 'gpt-5.6-luna');
  assert.equal(output.scanAudit.attempts[0].selected, true);
  assert.deepEqual(output.scanAudit.attempts.map(a => a.stage), ['consensus_1', 'consensus_2']);
  assert.equal(output.scanAudit.attempts[0].usage.input_tokens, 10);
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(logs).includes(image));
});
test('wrong printed line count: one Terra priority retry, good result selected and both calls retained', async () => {
  const { output, calls } = await request([...agreed(doc({ itemsPrintedLines: 2 })), answer(doc())]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].model, 'gpt-5.6-terra');
  assert.equal(calls[2].service_tier, 'priority');
  assert.equal(output.model, 'gpt-5.6-terra');
  assert.equal(output.consensus.agreed, true, 'identical reads never escalate on their own');
  assert.equal(output.paperValidation[0].ok, true);
  assert.deepEqual(output.scanAudit.attempts.map(a => a.selected), [false, false, true]);
});
test('failed or worse retry preserves the first result and records the failure', async () => {
  const first = doc({ subtotalExVat: 49 });
  for (const third of [new Error('test network failure'), answer(doc({ subtotalExVat: null }))]) {
    const { output, calls } = await request([...agreed(first), third]);
    assert.equal(calls.length, 3);
    assert.equal(output.scan.documents[0].subtotalExVat, 49);
    assert.equal(output.scanAudit.attempts[0].selected, true);
    assert.equal(output.paperValidation[0].ok, false);
  }
});
test('missing summary asks for the missing page without an automatic paid reread', async () => {
  const { output, calls } = await request(agreed(doc({ itemsPrintedLines: null })));
  assert.equal(calls.length, 2);
  assert.equal(output.paperValidation[0].missingSummary, true);
  assert.equal(output.checksumRetryAttempted, false);
});
test('self-consistent paper disproves a wrong typed anchor without escalation', async () => {
  const { output, calls } = await request(agreed(doc()), [{ ...input[0], expectedSubtotalExVat: 60 }]);
  assert.equal(calls.length, 2);
  assert.equal(output.error, 'anchor_mismatch_printed');
  assert.equal(output.scanAudit.attempts.length, 2);
});
test('invalid initial output is audited and never blindly retried', async () => {
  const { output, calls } = await request([{ output_text: 'invalid json' }, { output_text: 'invalid json' }]);
  assert.equal(calls.length, 2);
  assert.equal(output.ok, false);
  assert.equal(output.scanAudit.attempts[0].outcome, 'invalid_output');
});

test('quantity typo triggers one corrective read even when document totals and line counts match', async () => {
  const { output, calls } = await request([...agreed(doc({ rows: [row({ quantity: 9 })] })), answer(doc())]);
  assert.equal(calls.length, 3);
  assert.equal(output.model, 'gpt-5.6-terra');
  assert.equal(output.paperValidation[0].ok, true);
});

test('valid mixed and credit photos return review guidance without another model call', async () => {
  for (const d of [doc({ docType: 'credit', subtotalExVat: -50 }), doc({ subtotalExVat: 40,
    returnsPrintedLines: 1, rows: [row(), row({ section: 'returns', quantity: 2, lineTotalExVat: 10 })] })]) {
    const { output, calls } = await request(agreed(d));
    assert.equal(calls.length, 2);
    assert.equal(output.paperValidation[0].receivable, false);
    assert.equal(output.scanAudit.result, 'paper_needs_review');
    assert.equal(output.scan.documents[0].subtotalExVat, d.subtotalExVat);
  }
});

// ===== v11: קונצנזוס שתי הקריאות =====
// שתי שורות שהכסף בהן זהה והקוד שונה: בדיוק הכשל של תעודה 561010707, שבו
// עמודת הקוד הוסטה בשורה אחת וכל בדיקת סיכומים עברה בשלמות.
const shiftedCodes = doc({ itemsPrintedLines: 2, subtotalExVat: 80,
  rows: [row({ code: '111', lineNumber: 1 }), row({ code: '222', lineNumber: 2, quantity: 6, unitPriceExVat: 5, lineTotalExVat: 30 })] });
const shiftedCodesOther = doc({ itemsPrintedLines: 2, subtotalExVat: 80,
  rows: [row({ code: '111', lineNumber: 1 }), row({ code: '111', lineNumber: 2, quantity: 6, unitPriceExVat: 5, lineTotalExVat: 30 })] });

test('identity drift that the money cannot see is caught by the second read', () => {
  assert.deepEqual(scanConsensusDiff(scan(doc()), scan(doc())), []);
  const diffs = scanConsensusDiff(scan(shiftedCodes), scan(shiftedCodesOther));
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0], { noteIndex: 0, scope: 'row', rowIndex: 1, lineNumber: 2, field: 'code', values: ['222', '111'] });
  // התיאור והביטחון משתנים בין קריאות גם כשהנייר נקרא נכון — ולכן אינם הבדל.
  assert.deepEqual(scanConsensusDiff(scan(doc()), scan(doc({ confidence: .4, rows: [row({ description: 'חלב', confidence: .3 })] }))), []);
  assert.equal(scanConsensusDiff(scan(doc()), scan(doc({ rows: [row(), row({ lineNumber: 2 })] }))).some(d => d.field === 'rowCount'), true);
});

test('disputed rows are reported against the read that actually won', () => {
  const disputed = scanConsensusDisputedRows(scan(shiftedCodes), [scan(shiftedCodesOther)]);
  assert.equal(disputed.length, 1);
  assert.equal(disputed[0].rowIndex, 1);
  assert.equal(disputed[0].lineNumber, 2);
  assert.deepEqual(disputed[0].fields, [{ field: 'code', selected: '222', other: '111' }]);
  // שורה שנוספה או נעלמה מזיזה את כל מה שאחריה, ולכן המסמך כולו במחלוקת.
  assert.equal(scanConsensusDisputedRows(scan(shiftedCodes), [scan(doc())]).length, 2);
});

test('reads that disagree escalate to Terra, and the expensive read wins', async () => {
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(shiftedCodes)]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].model, 'gpt-5.6-terra');
  assert.equal(output.consensus.agreed, false);
  assert.equal(output.consensus.reason, 'reads_disagree');
  assert.equal(output.consensus.escalated, true);
  assert.equal(output.consensus.escalationModel, 'gpt-5.6-terra');
  assert.equal(output.scanAudit.attempts[2].stage, 'consensus_escalation');
  assert.deepEqual(output.scanAudit.attempts.map(a => a.selected), [false, false, true]);
  // ההנחיה המתקנת מתארת את ההבדל ואת כשל ההסטה, ואינה מבקשת לבחור בין הקריאות.
  const corrective = JSON.stringify(calls[2].input);
  assert.ok(corrective.includes('שורה 2'));
  assert.ok(corrective.includes('עמודת הקוד'));
  // גם אחרי שהמודל היקר הכריע, השורה שנחלקו עליה נשארת לאישור ידני.
  assert.equal(output.consensus.disputedRows.length, 1);
  assert.equal(output.consensus.disputedRows[0].lineNumber, 2);
  assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')));
});

test('a read that failed is not a witness: the scan escalates without a second opinion', async () => {
  const { output, calls } = await request([answer(doc()), new Error('test network failure'), answer(doc())]);
  assert.equal(calls.length, 3);
  assert.equal(output.ok, true);
  assert.equal(output.consensus.reason, 'read_failed');
  assert.equal(output.consensus.completedReads, 1);
  assert.equal(output.consensus.escalated, true);
  assert.equal(output.model, 'gpt-5.6-terra');
});

test('failed escalation keeps the cheap read and still raises the disputed row', async () => {
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), new Error('test network failure')]);
  assert.equal(calls.length, 3);
  assert.equal(output.ok, true);
  assert.equal(output.consensus.escalated, false);
  assert.equal(output.consensus.escalationError, 'openai_network_error');
  assert.equal(output.scan.documents[0].rows[1].code, '222', 'the first cheap read stays the answer');
  assert.equal(output.consensus.disputedRows.length, 1);
});

test('both reads failing returns the failure, not a half answer', async () => {
  const { output, calls } = await request([new Error('test network failure'), new Error('test network failure')]);
  assert.equal(calls.length, 2);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'openai_network_error');
});

test('OPENAI_CONSENSUS_READS=1 restores the single cheap read', async () => {
  const { output, calls } = await request([answer(doc())], input, { OPENAI_CONSENSUS_READS: '1' });
  assert.equal(calls.length, 1);
  assert.equal(output.ok, true);
  assert.equal(output.consensus.attempted, false);
  assert.equal(output.scanAudit.attempts[0].stage, 'initial');
});
