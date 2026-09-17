import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { tnuvaPaperCheck, scanChecksumMismatches, scanConsensusDiff, scanConsensusDisputedRows, scanConsensusMissingRows, alignConsensusRows, OPENAI_NETWORK_RETRY_WINDOW_MS, scanJobKey, scanJobId, createServer } from './server.js';

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
// v13: תשובה מזויפת שמתנהגת כמו ServerResponse אמיתי — מאזינים, כתיבה, וניתוק
// באמצע. בלי זה אי אפשר לבדוק את מה שקרה בחנות: הקו מת לפני שהתשובה נגמרה.
function fakeResponse() {
  const listeners = new Map();
  return {
    headersSent: false, writable: true, writableEnded: false, body: '', closed: false, resolveEnd: null,
    on(event, handler) { listeners.set(event, [...(listeners.get(event) || []), handler]); return this; },
    emit(event) { for (const handler of listeners.get(event) || []) handler(); },
    writeHead() { this.headersSent = true; return this; },
    write(chunk) { if (!this.writable) throw new Error('write after close'); this.body += chunk; return true; },
    end(chunk) { if (chunk != null) this.body += chunk; this.writableEnded = true; this.resolveEnd?.(); },
    drop() { this.writable = false; this.closed = true; this.emit('close'); }, // הקו מת
    json() { return JSON.parse(this.body); },
  };
}
function sendScan(server, body, { response = fakeResponse(), drain = true } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.url = '/scan'; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { origin: 'https://asafkiri.github.io', authorization: 'Bearer ' + token };
  const ended = new Promise(resolve => { response.resolveEnd = resolve; });
  server.emit('request', req, response);
  return { response, ended: drain ? ended.then(() => response.json()) : ended };
}
function scanServer(responses, extraEnv = {}) {
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
  return { server, calls, logs };
}
async function request(responses, documents = input, extraEnv = {}) {
  const { server, calls, logs } = scanServer(responses, extraEnv);
  const output = await sendScan(server, { documents, catalog }).ended;
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
  assert.deepEqual(diffs[0], { noteIndex: 0, scope: 'row', rowIndex: 1, otherRowIndex: 1, lineNumber: 2, field: 'code', values: ['222', '111'] });
  // התיאור והביטחון משתנים בין קריאות גם כשהנייר נקרא נכון — ולכן אינם הבדל.
  assert.deepEqual(scanConsensusDiff(scan(doc()), scan(doc({ confidence: .4, rows: [row({ description: 'חלב', confidence: .3 })] }))), []);
  assert.equal(scanConsensusDiff(scan(doc()), scan(doc({ rows: [row(), row({ lineNumber: 2 })] }))).some(d => d.field === 'rowCount'), true);
});

test('disputed rows are reported against the read that actually won', () => {
  const disputed = scanConsensusDisputedRows(scan(shiftedCodes), [scan(shiftedCodesOther)]);
  assert.equal(disputed.length, 1);
  assert.equal(disputed[0].rowIndex, 1);
  assert.equal(disputed[0].lineNumber, 2);
  assert.deepEqual(disputed[0].fields, [{ field: 'code', selected: '222', other: '111', confirmed: 0 }]);
  // קריאה שראתה שורה אחת בלבד: השורה הראשונה מזווגת לפי הכסף (קוד שונה),
  // והשנייה נותרת בלי בת-זוג — שתי שורות במחלוקת, כל אחת מסיבתה שלה.
  const short = scanConsensusDisputedRows(scan(shiftedCodes), [scan(doc())]);
  assert.deepEqual(short.map(item => [item.rowIndex, item.fields.map(field => field.field)]), [[0, ['code']], [1, ['row']]]);
  assert.deepEqual(short[1].fields, [{ field: 'row', selected: 'נקראה', other: null, confirmed: 0 }]);
});

// ===== v14: השורות מושוות לפי תוכנן =====
// 17.9, 16:07: קריאה אחת ראתה 29 שורות בנייר של 28 — וכל 28 השורות עלו לאישור
// ידני עם "מספר שורות: 28 מול 29", אף שהקריאה שנבחרה נסגרה מול הנייר.
const paper = rows => {
  const subtotalExVat = Math.round(rows.reduce((sum, item) => sum + item.lineTotalExVat, 0) * 100) / 100;
  const vatAmount = Math.round(subtotalExVat * 18) / 100;
  return doc({ itemsPrintedLines: rows.length, rows, subtotalExVat, vatAmount, totalInclVat: Math.round((subtotalExVat + vatAmount) * 100) / 100 });
};
const fourRows = () => [row({ code: '111', lineNumber: 1 }),
  row({ code: '222', lineNumber: 2, quantity: 6, unitPriceExVat: 5, lineTotalExVat: 30 }),
  row({ code: '333', lineNumber: 3, quantity: 2, unitPriceExVat: 4, lineTotalExVat: 8 }),
  row({ code: '444', lineNumber: 4, quantity: 1, unitPriceExVat: 3, lineTotalExVat: 3 })];
const fourRowPaper = paper(fourRows());
// אותו נייר (אותו מונה מודפס, אותו סיכום), כשקריאה פיצלה את השורה השנייה
// לשתיים: 29 מול 28 בזעיר אנפין.
const splitRowPaper = doc({ ...fourRowPaper, rows: [fourRows()[0],
  row({ code: '222', lineNumber: 2, quantity: 3, unitPriceExVat: 5, lineTotalExVat: 15 }),
  row({ code: '222', lineNumber: 3, quantity: 3, unitPriceExVat: 5, lineTotalExVat: 15 }),
  fourRows()[2], fourRows()[3]] });
// אותו נייר, כשקריאה פספסה את השורה השלישית.
const droppedRowPaper = doc({ ...fourRowPaper, rows: [fourRows()[0], fourRows()[1], fourRows()[3]] });

test('rows are aligned by content, so an extra row in one read disturbs only itself', () => {
  assert.deepEqual(alignConsensusRows(fourRowPaper.rows, splitRowPaper.rows),
    [{ a: 0, b: 0 }, { a: 1, b: 1 }, { a: null, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 4 }]);
  assert.deepEqual(alignConsensusRows(fourRowPaper.rows, droppedRowPaper.rows),
    [{ a: 0, b: 0 }, { a: 1, b: 1 }, { a: 2, b: null }, { a: 3, b: 2 }]);
  // ההבדלים: מספר השורות, השורה שפוצלה (כמות וסכום), והחצי השני שאין לו זוג.
  const diffs = scanConsensusDiff(scan(fourRowPaper), scan(splitRowPaper));
  assert.deepEqual(diffs.map(diff => [diff.scope, diff.field, diff.rowIndex ?? null, diff.otherRowIndex ?? null]),
    [['document', 'rowCount', null, null], ['row', 'quantity', 1, 1], ['row', 'lineTotalExVat', 1, 1], ['row', 'row', null, 2]]);
  // רק השורה שפוצלה במחלוקת — לא 28 שורות, ובלי שדה "מספר שורות" על אף שורה.
  const disputed = scanConsensusDisputedRows(scan(fourRowPaper), [scan(splitRowPaper)]);
  assert.deepEqual(disputed.map(item => [item.rowIndex, item.fields.map(field => field.field)]), [[1, ['quantity', 'lineTotalExVat']]]);
  assert.ok(!JSON.stringify(disputed).includes('rowCount'));
  // שורה שהקריאה השנייה המציאה ואינה דומה לשום שורה אינה מחלוקת על שורות אמיתיות.
  const invented = paper([...fourRows(), row({ code: '999', lineNumber: 5, quantity: 7, unitPriceExVat: 9, lineTotalExVat: 63 })]);
  assert.deepEqual(scanConsensusDisputedRows(scan(fourRowPaper), [scan(invented)]), []);
  // קריאות עם אותו מספר שורות עדיין מושוות שדה מול שדה, גם כששורה שונה בכולם.
  const replaced = paper([fourRows()[0], fourRows()[1], row({ code: '777', lineNumber: 3, quantity: 5, unitPriceExVat: 7, lineTotalExVat: 35 }), fourRows()[3]]);
  assert.deepEqual(scanConsensusDisputedRows(scan(fourRowPaper), [scan(replaced)]).map(item => [item.rowIndex, item.fields.map(field => field.field)]),
    [[2, ['code', 'quantity', 'unitPriceExVat', 'lineTotalExVat']]]);
});

test('a row only the winning read saw is a question, unless the paper itself closes with it', () => {
  const alone = scanConsensusDisputedRows(scan(fourRowPaper), [scan(droppedRowPaper)]);
  assert.deepEqual(alone, [{ noteIndex: 0, rowIndex: 2, lineNumber: 3, code: '333', description: 'חלב בדיקה',
    fields: [{ field: 'row', selected: 'נקראה', other: null, confirmed: 0 }] }]);
  // הנייר נסגר עם ארבע שורות — מונה מודפס וסיכום — ולכן השורה השלישית קיימת.
  // מי היא, הנייר אינו יודע: הזהות נשארת שאלת קוד שהמאגר והמחיר סוגרים אצל הלקוח.
  assert.deepEqual(scanConsensusDisputedRows(scan(fourRowPaper), [scan(droppedRowPaper)], { paperConfirmsRows: () => true })
    .map(item => [item.rowIndex, item.fields]), [[2, [{ field: 'code', selected: '333', other: null, confirmed: 0 }]]]);
  // הנייר מאשר את קיום השורה, לא את תוכנה: הבדל בשדה נשאר מחלוקת.
  const changed = paper(fourRows().map((item, index) => index === 3 ? row({ ...item, quantity: 2, lineTotalExVat: 6 }) : item));
  assert.deepEqual(scanConsensusDisputedRows(scan(fourRowPaper), [scan(changed)], { paperConfirmsRows: () => true })
    .map(item => [item.rowIndex, item.fields.map(field => field.field)]), [[3, ['quantity', 'lineTotalExVat']]]);
});

test('a value the winning read shares with one other read is settled; a value nobody confirms is not', () => {
  const agree = scan(fourRowPaper);
  const withRow1 = change => scan(paper(fourRows().map((item, index) => index === 1 ? row({ ...item, ...change }) : item)));
  const qtyDiffer = withRow1({ quantity: 7, lineTotalExVat: 35 }), qtyDifferAgain = withRow1({ quantity: 8, lineTotalExVat: 40 });
  // שתיים מתוך שלוש: המודל היקר וקריאה זולה אחת מסכימים — אין מה לשאול.
  assert.deepEqual(scanConsensusDisputedRows(agree, [agree, qtyDiffer]), []);
  assert.deepEqual(scanConsensusDisputedRows(agree, [qtyDiffer, agree]), []);
  // שתי הקריאות הזולות קראו אחרת — הערך שנבחר נשאר לבדו, ולכן במחלוקת.
  assert.deepEqual(scanConsensusDisputedRows(agree, [qtyDiffer, qtyDifferAgain]).map(item => [item.rowIndex, item.fields]),
    [[1, [{ field: 'quantity', selected: 6, other: 7, confirmed: 0 }, { field: 'lineTotalExVat', selected: 30, other: 35, confirmed: 0 }]]]);
  // מול קריאה אחת בלבד אין דעה שלישית, וכל הבדל נשאר מחלוקת.
  assert.deepEqual(scanConsensusDisputedRows(agree, [qtyDiffer]).map(item => item.rowIndex), [1]);
  // קוד נמסר תמיד, עם מספר הקריאות שמאשרות את הקוד שנבחר: הלקוח מכריע קוד
  // מול המאגר והמחיר, וזקוק לקוד היריב גם כשקריאה נוספת מסכימה עם הנבחר.
  const differ = withRow1({ code: '221' }), differAgain = withRow1({ code: '212' }), unread = withRow1({ code: null });
  assert.deepEqual(scanConsensusDisputedRows(agree, [agree, differ]).map(item => [item.rowIndex, item.fields]),
    [[1, [{ field: 'code', selected: '222', other: '221', confirmed: 1 }]]]);
  assert.deepEqual(scanConsensusDisputedRows(agree, [differ, differAgain]).map(item => [item.rowIndex, item.fields]),
    [[1, [{ field: 'code', selected: '222', other: '221', confirmed: 0 }]]]);
  // קריאה שלא הצליחה לקרוא את הקוד אינה היריב שמוצג: הקוד שנקרא בפועל הוא.
  assert.deepEqual(scanConsensusDisputedRows(agree, [unread, differ])[0].fields, [{ field: 'code', selected: '222', other: '221', confirmed: 0 }]);
  assert.deepEqual(scanConsensusDisputedRows(agree, [unread])[0].fields, [{ field: 'code', selected: '222', other: null, confirmed: 0 }]);
  // קריאה שלא ראתה את השורה אינה מאשרת אותה, אבל גם אינה חולקת על שדותיה.
  const droppedSecond = scan(doc({ ...fourRowPaper, rows: [fourRows()[0], fourRows()[2], fourRows()[3]] }));
  assert.deepEqual(scanConsensusDisputedRows(agree, [droppedSecond, agree]), []);
  assert.deepEqual(scanConsensusDisputedRows(agree, [droppedSecond, differ]).map(item => [item.rowIndex, item.fields]),
    [[1, [{ field: 'code', selected: '222', other: '221', confirmed: 0 }]]]);
  // ושורה שאף קריאה אחרת לא ראתה — שאלה על עצם קיומה, כל עוד הנייר אינו סוגר אותה.
  assert.deepEqual(scanConsensusDisputedRows(agree, [droppedSecond, droppedSecond]).map(item => [item.rowIndex, item.fields.map(field => field.field)]), [[1, ['row']]]);
});

test('a row every other read saw and the winning read dropped is named, unless the paper closes without it', () => {
  const missing = scanConsensusMissingRows(scan(droppedRowPaper), [scan(fourRowPaper), scan(fourRowPaper)]);
  assert.deepEqual(missing, [{ noteIndex: 0, lineNumber: 3, code: '333', description: 'חלב בדיקה', quantity: 2, unitPriceExVat: 4, lineTotalExVat: 8 }]);
  // שורה שרק קריאה אחת מתוך שתיים ראתה היא ההמצאה שלה, לא שורה חסרה.
  assert.deepEqual(scanConsensusMissingRows(scan(droppedRowPaper), [scan(fourRowPaper), scan(droppedRowPaper)]), []);
  // ונייר שנסגר מול הקריאה שנבחרה אינו חסר שורה, יהיו הקריאות האחרות אשר יהיו.
  assert.deepEqual(scanConsensusMissingRows(scan(droppedRowPaper), [scan(fourRowPaper), scan(fourRowPaper)], { paperConfirmsRows: () => true }), []);
});

test('reads that disagree escalate to Terra, and the expensive read wins', async () => {
  const thirdReading = doc({ ...shiftedCodes, rows: [shiftedCodes.rows[0], row({ ...shiftedCodes.rows[1], code: '333' })] });
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(thirdReading)]);
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
  // המודל היקר קרא קוד שלישי שאף קריאה אינה מאשרת — השורה נשארת לאישור ידני.
  assert.equal(output.scan.documents[0].rows[1].code, '333');
  assert.equal(output.consensus.disputedRows.length, 1);
  assert.equal(output.consensus.disputedRows[0].lineNumber, 2);
  assert.deepEqual(output.consensus.disputedRows[0].fields, [{ field: 'code', selected: '333', other: '222', confirmed: 0 }]);
  assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')));
});

test('a code one cheap read confirms is reported for the catalog to settle, not for the user', async () => {
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(shiftedCodes)]);
  assert.equal(calls.length, 3);
  assert.equal(output.consensus.escalated, true);
  assert.equal(output.scan.documents[0].rows[1].code, '222');
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, item.fields]),
    [[1, [{ field: 'code', selected: '222', other: '111', confirmed: 1 }]]]);
  assert.ok(!output.scan.warnings.some(warning => warning.includes('אישור ידני')), 'no manual approval is demanded for a confirmed code');
});

test('a checksum retry that replaces two agreeing reads is still measured against them', async () => {
  // שתי הקריאות הזולות הסכימו על נייר שאינו נסגר; קריאת ההצלה ניצחה עם קוד אחר.
  const wrongSum = doc({ subtotalExVat: 49 });
  const { output, calls } = await request([...agreed(wrongSum), answer(doc({ rows: [row({ code: '9' })] }))]);
  assert.equal(calls.length, 3);
  assert.equal(output.consensus.agreed, true);
  assert.equal(output.checksumRetryAttempted, true);
  assert.equal(output.scan.documents[0].rows[0].code, '9');
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, item.fields]),
    [[0, [{ field: 'code', selected: '9', other: '8', confirmed: 0 }]]]);
});

test('a read that saw one row too many does not put the whole paper in dispute', async () => {
  // הקריאה השנייה פיצלה שורה; ההסלמה קראה כמו הראשונה, והנייר נסגר עם ארבע שורות.
  const { output, calls } = await request([answer(fourRowPaper), answer(splitRowPaper), answer(fourRowPaper)]);
  assert.equal(calls.length, 3);
  assert.equal(output.consensus.escalated, true);
  assert.ok(output.consensus.diffs.some(diff => diff.field === 'rowCount'));
  const corrective = JSON.stringify(calls[2].input);
  assert.ok(corrective.includes('מספר השורות'));
  assert.ok(corrective.includes('נקראה בקריאה אחת בלבד'));
  assert.equal(output.paperValidation[0].ok, true);
  assert.deepEqual(output.consensus.disputedRows, []);
  assert.ok(!JSON.stringify(output).includes('"rowCount","selected"'));
  // ושתי קריאות זולות שפספסו שורה אינן מטילות ספק בקיומה של שורה שהמודל היקר
  // ראה והנייר סוגר — רק בזהותה, שנשארת שאלת קוד מול "לא נקרא".
  const missed = doc({ ...droppedRowPaper, rows: droppedRowPaper.rows.map((item, index) => index === 0 ? row({ ...item, promoStar: true }) : item) });
  const second = await request([answer(droppedRowPaper), answer(missed), answer(fourRowPaper)]);
  assert.equal(second.output.consensus.escalated, true);
  assert.equal(second.output.scan.documents[0].rows.length, 4);
  assert.equal(second.output.paperValidation[0].ok, true);
  assert.deepEqual(second.output.consensus.disputedRows.map(item => [item.rowIndex, item.fields]),
    [[2, [{ field: 'code', selected: '333', other: null, confirmed: 0 }]]]);
  assert.deepEqual(second.output.consensus.missingRows, []);
});

test('a row every other read saw and the winning read dropped is named next to the paper gap', async () => {
  // שתי הקריאות הזולות ראו ארבע שורות ונחלקו על כמות; ההסלמה פספסה שורה, וגם
  // קריאת ההצלה של סכום הביקורת — הנייר אינו נסגר, והשורה החסרה נאמרת בשמה.
  const otherQty = doc({ ...fourRowPaper, rows: fourRows().map((item, index) => index === 3 ? row({ ...item, quantity: 2, lineTotalExVat: 6 }) : item) });
  const { output, calls } = await request([answer(fourRowPaper), answer(otherQty), answer(droppedRowPaper), answer(droppedRowPaper)]);
  assert.equal(calls.length, 4, 'escalation, then one checksum retry because the paper does not close');
  assert.equal(output.paperValidation[0].ok, false);
  assert.deepEqual(output.consensus.missingRows.map(item => [item.lineNumber, item.code]), [[3, '333']]);
  assert.ok(output.scan.warnings.some(warning => warning.includes('שורה שהקריאה שנבחרה לא') && warning.includes('קוד 333')));
});

test('a read that keeps failing is not a witness: the scan escalates without a second opinion', async () => {
  // הנפילה חוזרת גם בניסיון הנוסף, ולכן נשארת קריאה אחת בלבד.
  const { output, calls } = await request([answer(doc()), new Error('test network failure'), new Error('test network failure'), answer(doc())]);
  assert.equal(calls.length, 4);
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

test('both reads failing, twice each, returns the failure and not a half answer', async () => {
  const drop = () => new Error('test network failure');
  const { output, calls } = await request([drop(), drop(), drop(), drop()]);
  assert.equal(calls.length, 4);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'openai_network_error');
});

// v12: נתק בדרך אל המודל אינו תשובה — הקריאה שנפלה מהר מנסה שוב פעם אחת.
test('a read dropped on the way to the model is retried once, and the scan never sees it', async () => {
  const { output, calls } = await request([answer(doc()), new Error('test network failure'), answer(doc())]);
  assert.equal(calls.length, 3, 'two reads, one of them after a retry');
  assert.equal(output.ok, true);
  assert.equal(output.consensus.agreed, true, 'the retried read answered, so the two reads agree');
  assert.equal(output.consensus.escalated, false, 'a dropped connection never costs an escalation');
  assert.deepEqual(output.scanAudit.attempts.map(a => a.stage), ['consensus_1', 'consensus_2', 'consensus_2_retry']);
  assert.equal(output.scanAudit.attempts[1].outcome, 'network_error_retried');
});

test('a read that fails slowly is not retried, because it was read and not dropped', () => {
  // סף הניסיון החוזר הוא 60 שניות: נפילה מהירה היא נתק, נפילה איטית היא קריאה.
  assert.equal(typeof OPENAI_NETWORK_RETRY_WINDOW_MS, 'number');
  assert.equal(OPENAI_NETWORK_RETRY_WINDOW_MS, 60_000);
});

test('OPENAI_CONSENSUS_READS=1 restores the single cheap read', async () => {
  const { output, calls } = await request([answer(doc())], input, { OPENAI_CONSENSUS_READS: '1' });
  assert.equal(calls.length, 1);
  assert.equal(output.ok, true);
  assert.equal(output.consensus.attempted, false);
  assert.equal(output.scanAudit.attempts[0].stage, 'initial');
});

test('a column shift across a run of identical-money rows is still disputed row by row', () => {
  // שלוש שורות רצופות עם אותו כסף (שלושה טעמים של אותו מעדן): הקוד המוסט הוא
  // הראיה היחידה, ורק השוואה לפי מיקום רואה אותו. הקריאה המוסטת היא שנבחרה.
  const triple = paper([row({ code: '111', lineNumber: 1 }), row({ code: '222', lineNumber: 2 }), row({ code: '333', lineNumber: 3 }),
    row({ code: '444', lineNumber: 4, quantity: 2, unitPriceExVat: 4, lineTotalExVat: 8 })]);
  const shifted = doc({ ...triple, rows: triple.rows.map((item, index) => index === 0 ? item : { ...item, code: triple.rows[index - 1].code }) });
  assert.deepEqual(scanConsensusDisputedRows(scan(shifted), [scan(triple)], { paperConfirmsRows: () => true })
    .map(item => [item.rowIndex, item.fields.map(field => field.field + ':' + field.other)]),
    [[1, ['code:222']], [2, ['code:333']], [3, ['code:444']]]);
  // שתי קריאות עם אותו מספר שורות שסדרן שונה — הבדלי שדות בשורות שהוזזו, כמו עד כה.
  const rotated = doc({ ...triple, rows: [triple.rows[3], ...triple.rows.slice(0, 3)] });
  assert.deepEqual(scanConsensusDiff(scan(triple), scan(rotated)).filter(diff => diff.scope === 'row').map(diff => diff.rowIndex + ':' + diff.field),
    ['0:code', '0:quantity', '0:unitPriceExVat', '0:lineTotalExVat', '1:code', '2:code', '3:code', '3:quantity', '3:unitPriceExVat', '3:lineTotalExVat']);
});

// ===== התעודה האמיתית של 17.9 (גיבוי 12:29), כפי שהמודל היקר קרא אותה =====
// 28 שורות שנסגרות מול הסיכום המודפס; lineNumber לא נקרא באף שורה, כמו בפועל.
const REAL_ROWS = [
  ['4131074', 'תנ 32% קרט חלב', 128, 5.36, 686.08, true], ['4136598', 'הפ.אוכל קורנפלקס', 12, 6.72, 80.64, false],
  ['4125578', '10 ל.חומשר', 8, 7.32, 58.56, true], ['10325619', 'משקה שיבולת שועל', 8, 8.82, 70.56, true],
  ['16936413', 'מוצרלה פרסקה 100 ג', 5, 7.42, 37.1, false], ['43890', 'ריוויון 1 ליטר', 12, 9.45, 113.4, false],
  ['44248', 'ריוויון 500', 6, 5.46, 32.76, false], ['10321277', "קוטג' י. קטנה מהדרין", 10, 2.02, 20.2, true],
  ['10328627', 'יוג. גר טרי דנונה קר', 6, 4.39, 26.34, true], ['14761056', 'מעדן שוקולד חלב YOLO', 10, 3.47, 34.7, false],
  ['14761414', 'מעדן שוקומלבו YOLO', 6, 3.47, 20.82, false], ['72961506', 'חלב טרי 1.25ל', 12, 2.58, 30.96, false],
  ['4125721', 'שוקו 1.5% מהדרין', 24, 6.77, 162.48, false], ['16935621', 'גורגוט GO נגיסה ונ', 6, 4.39, 26.34, true],
  ['16936222', 'תלבון גר אננס ממותק', 6, 4.39, 26.34, false], ['16934402', 'מעדן גר אורירי ת', 4, 4.39, 17.56, false],
  ['420108', 'יופ. דנונה', 12, 3.69, 44.28, false], ['51376', 'יופ. ד.אנס', 12, 3.69, 44.28, false],
  ['4125509', 'שמנת אורז 100', 36, 1.39, 50.04, false], ['4121280', 'שומשומצי תנה', 72, 1.13, 81.36, false],
  ['414407', 'לבן מועד', 36, 0.81, 29.16, false], ['57132', 'יוגורט בריאות 200', 12, 2.37, 28.44, false],
  ['48185', 'גבינה 5% 250 מהדרין', 24, 4.19, 100.56, false], ['41445', "קוטג' 250 מהדרין", 24, 4.6, 110.4, false],
  ['4127336', "קוטג' 250 י. מהדרין", 24, 4.6, 110.4, false], ['59259', 'ארגז חלב ירוק', 9, 15.1, 135.9, false],
  ['59549', 'ארגז חלב שקוף', 3, 22, 66, false], ['59631', 'ארגז פלסטיק 30/40 אפור', 6, 13.5, 81, false]];
const realPaper = () => doc({ docNumber: '274398', docDate: '17/09/2026', itemsSectionTotalExVat: 2326.66, promoDiscountExVat: 32.02,
  itemsPrintedLines: 28, subtotalExVat: 2294.64, vatAmount: 413.04, totalInclVat: 2707.7, roundingDiff: 0.02, confidence: .78,
  rows: REAL_ROWS.map(([code, description, quantity, unitPriceExVat, lineTotalExVat, promoStar]) =>
    ({ sourcePage: 1, lineNumber: null, section: 'items', code, description, quantity, unitPriceExVat, lineTotalExVat, promoStar, confidence: .7 })) });
const withRows = (base, edits) => doc({ ...base, rows: base.rows.map((item, index) => edits[index] ? { ...item, ...edits[index] } : item) });

test('the 12:29 paper: the disputes the day actually produced, against the reads that produced them', () => {
  const terra = realPaper();
  assert.equal(tnuvaPaperCheck(terra, 1).ok, true);
  // שתי הקריאות הזולות כפי ששוחזרו מהגיבוי: נחלקו ביניהן על שורות 16 ו-25,
  // ושתיהן קראו אחרת מהמודל היקר את שורות 0, 7, 10, 15 ו-20.
  const shared = { 0: { promoStar: false }, 7: { promoStar: false }, 10: { code: '14761014' }, 15: { promoStar: true }, 20: { code: '41407' } };
  const luna1 = withRows(terra, { ...shared, 25: { code: '52959' } });
  const luna2 = withRows(terra, { ...shared, 16: { code: null } });
  const disputed = scanConsensusDisputedRows(scan(terra), [scan(luna1), scan(luna2)], { paperConfirmsRows: () => true });
  assert.deepEqual(disputed.map(item => [item.rowIndex, item.fields.map(field => field.field + ':' + field.other + ':' + field.confirmed)]), [
    [0, ['promoStar:false:0']], [7, ['promoStar:false:0']], [10, ['code:14761014:0']], [15, ['promoStar:true:0']],
    [16, ['code:null:1']], [20, ['code:41407:0']], [25, ['code:52959:1']]]);
  // lineNumber שלא נקרא — מספר השורה הוא מיקומה בטבלה.
  assert.deepEqual(disputed.map(item => item.lineNumber), [1, 8, 11, 16, 17, 21, 26]);
});

test('the 12:29 paper with both cheap reads at 29 rows, split in different places, closes at 28 without a flood', async () => {
  const terra = realPaper();
  const half = item => ({ ...item, quantity: item.quantity / 2, lineTotalExVat: Math.round(item.lineTotalExVat * 50) / 100 });
  const split = (base, at) => doc({ ...base, rows: base.rows.flatMap((item, index) => index === at ? [half(item), half(item)] : [item]) });
  const luna1 = split(withRows(terra, { 0: { promoStar: false } }), 12);
  const luna2 = split(withRows(terra, { 20: { code: '41407' } }), 5);
  const { output, calls } = await request([answer(luna1), answer(luna2), answer(terra)]);
  assert.equal(calls.length, 3, 'the cheap reads disagree, Terra decides');
  assert.equal(output.scan.documents[0].rows.length, 28);
  assert.equal(output.paperValidation[0].ok, true);
  assert.ok(output.consensus.diffs.length > 0);
  assert.ok(!JSON.stringify(output.consensus.disputedRows).includes('rowCount'));
  // הכוכבית והשורות שפוצלו מאושרות בידי הקריאה הזולה השנייה; הקוד היריב של שורה
  // 21 נמסר עם אישור — למאגר להכריע, לא למשתמש.
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, item.fields.map(field => field.field + ':' + field.other + ':' + field.confirmed)]),
    [[20, ['code:41407:1']]]);
  assert.deepEqual(output.consensus.missingRows, []);
  assert.ok(!output.scan.warnings.some(warning => warning.includes('אישור ידני')));
});

// ===== v13: הסריקה שורדת את הקו =====
// זה הכשל שחזר בחנות ב-17.9: קריאה כפולה + הסלמה נמשכת דקה וחצי עד שתיים,
// הטלפון מאבד את החיבור באמצע, והלקוח קיבל גוף קטוע בלי קוד ובלי יומן —
// כלומר סריקה שלמה ששולמה במלואה נזרקה לפח, והמשתמש צילם הכול מחדש.
const key = 'scan-key-1234';
test('a connection that dies mid-scan does not lose the scan: the same key collects it', async () => {
  const { server, calls } = scanServer(agreed(doc()));
  const first = sendScan(server, { documents: input, catalog, scanKey: key }, { drain: false });
  first.response.drop(); // הטלפון איבד את הקו בזמן שהמודל עוד קורא
  const resumed = await sendScan(server, { scanKey: key, resume: true }).ended;
  assert.equal(calls.length, 2, 'the paid reads happened once, not twice');
  assert.equal(resumed.ok, true);
  assert.equal(resumed.scanKey, key);
  assert.equal(resumed.scan.documents[0].subtotalExVat, 50);
  assert.ok(resumed.scanAudit, 'the audit comes back with it, so a failure stays diagnosable');
  assert.equal(first.response.writableEnded, false, 'nothing was written to the dead connection');
  server.close();
});
test('the same key sent again joins the running scan instead of paying for a second one', async () => {
  const { server, calls } = scanServer(agreed(doc()));
  const first = sendScan(server, { documents: input, catalog, scanKey: key });
  const second = sendScan(server, { documents: input, catalog, scanKey: key });
  const [a, b] = await Promise.all([first.ended, second.ended]);
  assert.equal(calls.length, 2, 'two reads for one scan — not four');
  assert.deepEqual(a, b);
  server.close();
});
test('a key the instance never saw says so, so the client knows to send the photos again', async () => {
  const { server, calls } = scanServer([]);
  const output = await sendScan(server, { scanKey: 'no-such-key-01', resume: true }).ended;
  assert.equal(output.ok, false);
  assert.equal(output.error, 'resume_unknown');
  assert.equal(output.serviceVersion, 14);
  assert.equal(calls.length, 0);
  server.close();
});
test('a scan with no key behaves exactly as before, and nothing is kept', async () => {
  const { output, calls } = await request(agreed(doc()));
  assert.equal(output.ok, true);
  assert.equal(output.scanKey, null);
  assert.equal(calls.length, 2);
});
test('a malformed key is ignored rather than trusted as an identity', () => {
  assert.equal(scanJobKey('scan-key-1234'), 'scan-key-1234');
  assert.equal(scanJobKey('short'), null);
  assert.equal(scanJobKey('has spaces in it'), null);
  assert.equal(scanJobKey('a'.repeat(65)), null);
  assert.equal(scanJobKey(null), null);
  assert.equal(scanJobId('uid', 'k'), 'uid|k');
});

// כישלון שמור אינו שווה איסוף: להחזיר אותו שוב ושוב נועל את התעודה על תקלה
// חולפת. איסוף מחזיר סריקה שהצליחה; אחרת הלקוח שולח את הצילומים לקריאה חדשה.
test('a saved failure is never replayed: the next attempt gets a real new read', async () => {
  const drop = () => new Error('test network failure');
  const { server, calls } = scanServer([drop(), drop(), drop(), drop(), ...agreed(doc())]);
  const failed = await sendScan(server, { documents: input, catalog, scanKey: key }).ended;
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'openai_network_error');
  assert.equal(calls.length, 4);
  // איסוף של הכישלון הזה אומר "אינני מכיר", ולא מחזיר את הכישלון עצמו
  const collected = await sendScan(server, { scanKey: key, resume: true }).ended;
  assert.equal(collected.error, 'resume_unknown');
  assert.equal(calls.length, 4, 'איסוף לעולם אינו קורא למודל');
  // ואותו מפתח, עם הצילומים, מקבל קריאה חדשה לגמרי
  const retried = await sendScan(server, { documents: input, catalog, scanKey: key }).ended;
  assert.equal(retried.ok, true);
  assert.equal(calls.length, 6, 'שתי קריאות חדשות, ולא תשובה שמורה');
  server.close();
});
test('a full send never collects a stored result: photos mean read, resume means collect', async () => {
  const { server, calls } = scanServer([...agreed(doc()), ...agreed(doc())]);
  const first = await sendScan(server, { documents: input, catalog, scanKey: key }).ended;
  assert.equal(first.ok, true);
  assert.equal(calls.length, 2);
  const again = await sendScan(server, { documents: input, catalog, scanKey: key }).ended;
  assert.equal(again.ok, true);
  assert.equal(calls.length, 4, 'הצילומים נקראו שוב, כי זאת בקשה לקרוא');
  const collected = await sendScan(server, { scanKey: key, resume: true }).ended;
  assert.equal(collected.ok, true);
  assert.equal(calls.length, 4, 'והאיסוף מחזיר את מה שכבר נקרא, בלי לשלם');
  server.close();
});
