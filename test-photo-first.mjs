import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Console } from 'node:console';
import { Readable, Writable } from 'node:stream';
import { tnuvaPaperCheck, scanChecksumMismatches, scanConsensusDiff, scanConsensusDisputedRows, scanConsensusMissingRows, scanConsensusDocDateUnconfirmed, alignConsensusRows, OPENAI_NETWORK_RETRY_WINDOW_MS, scanJobKey, scanJobId, createServer,
  tnuvaRowArithmetic, scanSecondStrongOpenFields, scanSecondStrongReadVotes } from './server.js';

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
});
test('service 17: an unreadable header is a regular document, and the reads never dispute the header', () => {
  // 15.10: the header was cut off in the photo; every row was read and the paper closed to the agora.
  const unknown = tnuvaPaperCheck(doc({ docType: 'unknown' }), 1);
  assert.equal(unknown.ok, true); assert.equal(unknown.receivable, true); assert.deepEqual(unknown.review, []);
  assert.equal(tnuvaPaperCheck(doc({ docType: undefined }), 1).receivable, true);
  const fields = diffs => diffs.filter(d => d.scope === 'document').map(d => d.field);
  assert.deepEqual(fields(scanConsensusDiff(scan(doc({ docType: 'invoice' })), scan(doc({ docType: 'unknown' })))), []);
  assert.deepEqual(fields(scanConsensusDiff(scan(doc({ docNumber: '561011080' })), scan(doc({ docNumber: null })))), []);
  assert.deepEqual(fields(scanConsensusDiff(scan(doc()), scan(doc({ docType: 'credit', subtotalExVat: -50 })))), ['docType', 'subtotalExVat']);
});
test('service 17: a credit note whose title was cut is stopped by its minus signs, without a paid retry', () => {
  // The paper sums close in absolute value, so there is nothing for a corrective read to "fix" by dropping the minus.
  const cut = tnuvaPaperCheck(doc({ docType: 'invoice', subtotalExVat: -50, vatAmount: -9, totalInclVat: -59 }), 1);
  assert.equal(cut.ok, true); assert.equal(cut.receivable, false); assert.equal(cut.retryable, false);
  assert.match(cut.review.join(' '), /כנראה חשבונית זיכוי/);
  assert.deepEqual(scanChecksumMismatches(scan(doc({ subtotalExVat: -50, vatAmount: -9, totalInclVat: -59 })), input), []);
  // Only part of the minus survived the read: still not ordinary goods.
  const partial = tnuvaPaperCheck(doc({ itemsSectionTotalExVat: -50, vatAmount: -9, totalInclVat: -59 }), 1);
  assert.equal(partial.ok, true); assert.equal(partial.receivable, false);
  assert.equal(tnuvaPaperCheck(doc({ roundingDiff: -0.03 }), 1).receivable, true, 'a negative rounding line is normal');
  // A mixed paper whose returns exceed its goods closes with its own sign: no paid retry.
  const mixed = doc({ itemsSectionTotalExVat: 50, returnsSectionTotalExVat: 80, returnsPrintedLines: 1, subtotalExVat: -30, vatAmount: -5.4, totalInclVat: -35.4,
    rows: [row(), row({ section: 'returns', quantity: 16, lineTotalExVat: 80 })] });
  const mixedCheck = tnuvaPaperCheck(mixed, 1);
  assert.equal(mixedCheck.ok, true); assert.equal(mixedCheck.receivable, false); assert.equal(mixedCheck.retryable, false);
  assert.deepEqual(scanChecksumMismatches(scan(mixed), input), []);
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
// settled: בקשת HTTP אמיתית כבר נסגרה כשגוף ה-JSON נקרא, ולכן מאזין "close" שנרשם
// אחר כך לעולם אינו נקרא. Readable.from סוגר מאוחר יותר, ובדיקה שממתינה בין השליחה
// לתשובה צריכה את ההתנהגות האמיתית.
function sendScan(server, body, { response = fakeResponse(), drain = true, settled = false } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))], settled ? { emitClose: false } : undefined);
  req.method = 'POST'; req.url = '/scan'; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { origin: 'https://asafkiri.github.io', authorization: 'Bearer ' + token };
  const ended = new Promise(resolve => { response.resolveEnd = resolve; });
  server.emit('request', req, response);
  return { response, ended: drain ? ended.then(() => response.json()) : ended };
}
// logger — יומן אמיתי (למשל Console שכותב לזרם), כשהבדיקה צריכה לראות את מה ש-Cloud Run מקבל.
function scanServer(responses, extraEnv = {}, logger = null) {
  const calls = [], logs = [];
  const server = createServer({ env: { OPENAI_API_KEY: 'fixture-only', OPENAI_MODEL: 'gpt-5.6-luna',
    OPENAI_RETRY_MODEL: 'gpt-5.6-terra', OPENAI_RETRY_SERVICE_TIER: 'priority', ...extraEnv },
    logger: logger || { info: (...args) => logs.push(args), error: error => { throw error; } },
    fetchImpl: async (url, options) => {
      if (url.includes('googleapis.com')) return Response.json({ keys: [jwk] });
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const call = JSON.parse(options.body); calls.push(call);
      let next = responses.shift();
      if (typeof next === 'function') next = await next(); // תשובה שמחכה לרגע שהבדיקה בוחרת
      if (next instanceof Error) throw next;
      assert.ok(next, 'Unexpected paid model call');
      return Response.json({ ...next, model: call.model, id: 'test-' + calls.length,
        usage: { input_tokens: 10, output_tokens: 20 } });
    } });
  return { server, calls, logs };
}
// v18: גוף הבקשה של אפליקציה 142 נושא strongReadSelection:true. בלעדיו — כמו
// באפליקציה ישנה — קריאת ההכרעה שהושלמה מנצחת תמיד. ברירת המחדל כאן היא הגוף
// הישן, ובדיקה שבודקת את הבחירה לפי הנייר שולחת את הדגל במפורש.
const APP_142 = { strongReadSelection: true };
async function request(responses, documents = input, extraEnv = {}, extraBody = {}) {
  const { server, calls, logs } = scanServer(responses, extraEnv);
  const output = await sendScan(server, { documents, catalog, ...extraBody }).ended;
  server.close();
  return { output, calls, logs };
}
const answer = document => ({ output_text: JSON.stringify(scan(document)) });
const promoRow = (changes = {}) => ({ barcode: null, name: 'בולגרית 5%', listPrice: 18.42, discountPct: 15, promoPrice: 15.66,
  noteText: null, noteKind: 'none', noteStartDate: null, noteEndDate: null, noteMinUnits: null, confidence: .99,
  sourceLine: 1, productHintId: 'a0', candidateProductHintIds: ['a0'], matchConfidence: .98, ...changes });
const promoInput = { mode: 'promoSheet', sheet: { title: 'אוקטובר 2026',
  lines: [{ page: 1, y: 700, parts: [[84, '15.66'], [139, '15%'], [196, '18.42'], [300, 'בולגרית 5%'], [474, '############']] }],
  catalog: [{ id: 'catalog-cheese', name: 'בולגרית 5% 250 גרם', price: 18.42, barcode: '7290000000008' }] } };
async function requestPromo(rows) {
  const { server, calls } = scanServer([{ output_text: JSON.stringify({ validFrom: '2026-10-01', validTo: '2026-10-31', rows, warnings: [] }) }]);
  const output = await sendScan(server, promoInput).ended;
  server.close();
  return { output, calls };
}
test('promo sheets without barcodes match only catalog aliases and preserve the original numbers', async () => {
  const { output, calls } = await requestPromo([promoRow()]);
  assert.equal(output.ok, true);
  assert.equal(output.promoCatalogMatching, true);
  assert.equal(output.serviceVersion, 19);
  assert.equal(output.sheet.rows[0].barcode, null);
  assert.equal(output.sheet.rows[0].productId, 'catalog-cheese');
  assert.deepEqual(output.sheet.rows[0].candidateProductIds, ['catalog-cheese']);
  assert.equal(output.sheet.rows[0].sourceLine, 1);
  assert.equal(output.sheet.rows[0].discountPct, 15);
  assert.equal(calls.length, 1);
  const userText = calls[0].input[1].content[0].text;
  assert.match(userText, /L1 \[y=700\]/);
  assert.match(userText, /בולגרית 5% 250 גרם/);
  assert.match(userText, /"id":"a0"/);
  assert.doesNotMatch(userText, /catalog-cheese|7290000000008/);
  const instructions = calls[0].input[0].content[0].text;
  assert.match(instructions, /מאצ'ה אינו סחלב/);
  assert.match(instructions, /candidateProductHintIds=\[\]/);
  assert.doesNotMatch(instructions, /שורה שאין בה ברקוד בן 13 ספרות אינה שורת מוצר/);
  assert.ok(calls[0].text.format.schema.properties.rows.items.required.includes('productHintId'));
});
test('promo matching does not accept invented product aliases or convert missing money to zero', async () => {
  const { output } = await requestPromo([promoRow({ productHintId: 'invented', candidateProductHintIds: ['invented', 'a0'], listPrice: null })]);
  assert.equal(output.ok, true);
  assert.equal(output.sheet.rows[0].productId, null);
  assert.deepEqual(output.sheet.rows[0].candidateProductIds, ['catalog-cheese']);
  assert.equal(output.sheet.rows[0].listPrice, null);
});
test('malformed identity fields from a promo model are rejected before reaching the client', async () => {
  const { output } = await requestPromo([promoRow({ candidateProductHintIds: 'a0' })]);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'invalid_model_output');
});
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
  assert.equal(output.consensus.escalationSelected, false);
  assert.equal(output.consensus.unverifiedSingleRead, false);
  assert.deepEqual(output.consensus.disputedRows, []);
  assert.deepEqual(output.consensus.docDateUnconfirmed, [], 'both reads read the same date');
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

test('reads that disagree escalate to Terra, and on a paper tie the expensive read wins', async () => {
  const thirdReading = doc({ ...shiftedCodes, rows: [shiftedCodes.rows[0], row({ ...shiftedCodes.rows[1], code: '333' })] });
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(thirdReading)], input, {}, APP_142);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].model, 'gpt-5.6-terra');
  assert.equal(output.consensus.agreed, false);
  assert.equal(output.consensus.reason, 'reads_disagree');
  assert.equal(output.consensus.escalated, true);
  assert.equal(output.consensus.escalationModel, 'gpt-5.6-terra');
  assert.equal(output.scanAudit.attempts[2].stage, 'consensus_escalation');
  // v18: שלוש הקריאות נסגרות מול הנייר באותה מידה — בשוויון ההכרעה נבחרת.
  assert.equal(output.consensus.strongReadSelection, true);
  assert.deepEqual(output.scanAudit.attempts.map(a => a.paperError), [0, 0, 0]);
  assert.deepEqual(output.scanAudit.attempts.map(a => a.selected), [false, false, true]);
  assert.equal(output.consensus.escalationSelected, true);
  assert.equal(output.consensus.unverifiedSingleRead, false);
  assert.equal(output.model, 'gpt-5.6-terra');
  // ההנחיה המתקנת מתארת את מקום ההבדל ואת כשל ההסטה, בלי הקודים שנקראו.
  const corrective = calls[2].input[1].content.at(-1).text;
  assert.ok(corrective.includes('שורה 2: code.'));
  assert.ok(corrective.includes('עמודת הקוד'));
  assert.ok(!corrective.includes('222') && !corrective.includes('111'));
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
  // v18: ההנחיה נותנת את המקום ואת שם השדה — מספר השורות, וקיום השורה שרק קריאה
  // אחת ראתה — ולא את הקוד או הכמות שנקראו בה.
  const corrective = calls[2].input[1].content.at(-1).text;
  assert.ok(corrective.includes('מספר השורות'));
  assert.ok(corrective.includes('שורה 3: קיום השורה'));
  assert.ok(!corrective.includes('קוד 222') && !corrective.includes('נקראה בקריאה אחת בלבד'));
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
  // v18: ההסלמה נבחרת כאן גם תחת הבחירה לפי הנייר, כי הקריאות הזולות לא קראו את
  // מונה הפריטים — הנייר שלהן אינו נבדק כלל. עד שירות 17, ובשירות 18 בלי הדגל,
  // היא נבחרת בכל מקרה; עם הדגל קריאה זולה שנסגרת מול הנייר הייתה גוברת עליה
  // (ראה הבדיקה של בחירה לפי הנייר).
  const unread = item => doc({ ...item, itemsPrintedLines: null });
  const otherQty = doc({ ...fourRowPaper, rows: fourRows().map((item, index) => index === 3 ? row({ ...item, quantity: 2, lineTotalExVat: 6 }) : item) });
  const { output, calls } = await request([answer(unread(fourRowPaper)), answer(unread(otherQty)), answer(droppedRowPaper), answer(droppedRowPaper)], input, {}, APP_142);
  assert.equal(calls.length, 4, 'escalation, then one checksum retry because the paper does not close');
  assert.equal(output.consensus.escalationSelected, true);
  assert.deepEqual(output.scanAudit.attempts.map(a => a.selected), [false, false, true, false]);
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
  // קריאת ההכרעה הושלמה, ולכן יש עד לקריאה שנבחרה.
  assert.equal(output.consensus.unverifiedSingleRead, false);
  // אין הבדלים להראות: ההנחיה אינה ממציאה מקומות, ועדיין מזהירה מהסטת העמודה.
  const corrective = calls[3].input[1].content.at(-1).text;
  assert.ok(corrective.includes('קריאה מקבילה של אותו צילום לא הושלמה'));
  assert.ok(corrective.includes('עמודת הקוד') && !corrective.includes('נחלקו במקומות'));
});

test('v18: one cheap read failed and the strong read failed too — the lone read is marked unverified', async () => {
  // עד שירות 17 זה חזר ok:true בלי מחלוקת ובלי אזהרה: קריאה אחת, בלי עד, שנראתה כמו הסכמה.
  const drop = () => new Error('test network failure');
  const { output, calls } = await request([answer(doc()), drop(), drop(), drop()]);
  assert.equal(calls.length, 4, 'two reads, one network retry, one failed escalation');
  assert.equal(output.ok, true);
  assert.equal(output.consensus.reason, 'read_failed');
  assert.equal(output.consensus.escalated, false);
  assert.equal(output.consensus.escalationError, 'openai_network_error');
  assert.equal(output.consensus.unverifiedSingleRead, true);
  assert.deepEqual(output.consensus.disputedRows, []);
  // אין עד שקרא תאריך אחר, ולכן התאריך אינו מסומן בנפרד: הסימון של קריאה בודדת
  // כבר אומר שאף קריאה אינה מאשרת דבר, והלקוח מחליט לפיו.
  assert.deepEqual(output.consensus.docDateUnconfirmed, []);
  assert.ok(output.scan.warnings.some(warning => warning.startsWith('רק קריאה אחת של הצילום הושלמה') && warning.includes('לפני קליטה')));
  assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
    [['consensus_1', true], ['consensus_2', false], ['consensus_2_retry', false], ['consensus_escalation', false]]);
});

test('failed escalation keeps the cheap read and still raises the disputed row', async () => {
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), new Error('test network failure')]);
  assert.equal(calls.length, 3);
  assert.equal(output.ok, true);
  assert.equal(output.consensus.escalated, false);
  assert.equal(output.consensus.escalationError, 'openai_network_error');
  assert.equal(output.scan.documents[0].rows[1].code, '222', 'the first cheap read stays the answer');
  assert.equal(output.consensus.disputedRows.length, 1);
  // הקריאה הזולה השנייה היא עד, ולכן זו אינה קריאה בודדת.
  assert.equal(output.consensus.unverifiedSingleRead, false);
  assert.equal(output.consensus.escalationSelected, false);
});

test('both reads failing, twice each, returns the failure and not a half answer', async () => {
  const drop = () => new Error('test network failure');
  const { output, calls } = await request([drop(), drop(), drop(), drop()]);
  assert.equal(calls.length, 4);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'openai_network_error');
});

// ===== v18: מה מסלים, מה קריאת ההכרעה יודעת, ומי נבחר =====
test('v18: fields that decide nothing are still reported, marked trigger:false', () => {
  const other = doc({ docDate: '1.9.2026', vatPct: 17, vatAmount: 8.5, totalInclVat: 58.5, roundingDiff: .02,
    rows: [row({ promoStar: true, sourcePage: 2 })] });
  assert.deepEqual(scanConsensusDiff(scan(doc()), scan(other)).map(diff => [diff.field, diff.trigger ?? true]), [
    ['docDate', false], ['vatPct', false], ['vatAmount', false], ['totalInclVat', false], ['roundingDiff', false],
    ['promoStar', true], ['sourcePage', false]]);
});

test('v18: a date or a page the reads disagree on costs no escalation', async () => {
  // התאריך — לאפליקציה 142 בלבד; בלי הדגל הוא מסלים כמו בשירות 17 (ראו בדיקת התאריך מול אפליקציה ישנה).
  const { output, calls } = await request([answer(doc()), answer(doc({ docDate: '1.9.2026' }))], input, {}, APP_142);
  assert.equal(calls.length, 2, 'one paid call fewer than service 17');
  assert.equal(output.consensus.agreed, true);
  assert.equal(output.consensus.escalated, false);
  assert.equal(output.consensus.reason, null);
  assert.deepEqual(output.consensus.diffs, [{ noteIndex: 0, scope: 'document', field: 'docDate', values: ['7.9.2026', '1.9.2026'], trigger: false }]);
  assert.deepEqual(output.consensus.disputedRows, []);
  assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.consensus, a.selected]), [['consensus_1', 'agreed', true], ['consensus_2', 'agreed', false]]);
  assert.equal(output.scan.documents[0].docDate, '7.9.2026');
  // שורה שכל קריאה שייכה לעמוד אחר — מידע בלבד אצל הלקוח, ולא הסלמה.
  const twoPages = [{ ...input[0], pages: [image, image] }];
  const onPage = page => doc({ pageCount: 2, itemsPrintedLines: 2, subtotalExVat: 80,
    rows: [row(), row({ code: '9', lineNumber: 2, sourcePage: page, quantity: 6, lineTotalExVat: 30 })] });
  const paged = await request([answer(onPage(2)), answer(onPage(1))], twoPages);
  assert.equal(paged.calls.length, 2);
  assert.equal(paged.output.consensus.agreed, true);
  assert.deepEqual(paged.output.consensus.diffs.map(diff => [diff.field, diff.rowIndex, diff.trigger]), [['sourcePage', 1, false]]);
  assert.equal(paged.output.paperValidation[0].ok, true);
  assert.ok(!paged.output.scan.warnings.length);
  // וכך גם המע"מ והסכום כולל מע"מ, שהלקוח מציג כאזהרה בלבד.
  const vat = await request([answer(doc()), answer(doc({ vatAmount: 9.01, totalInclVat: 59.01 }))]);
  assert.equal(vat.calls.length, 2);
  assert.equal(vat.output.consensus.agreed, true);
});

// v18: הכרעת בעל החנות — תאריך שלא נקרא היטב, היום. השירות אינו מחליף את
// התאריך המודפס; הוא אומר לאיזו תעודה אף קריאה אחרת אינה מאשרת את התאריך שנבחר.
test('v18: a date no other read confirms is named, though nothing escalates and the printed date stays', async () => {
  // אפליקציה 142 (הדגל): התאריך אינו מסלים, והאפליקציה עוברת להיום.
  const { output, calls } = await request([answer(doc()), answer(doc({ docDate: '1.9.2026' }))], input, {}, APP_142);
  assert.equal(calls.length, 2, 'still no escalation for a date');
  assert.equal(output.consensus.agreed, true);
  assert.deepEqual(output.consensus.docDateUnconfirmed, [0]);
  assert.equal(output.scan.documents[0].docDate, '7.9.2026', 'the printed value is returned as read');
  assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]), [['consensus_1', true], ['consensus_2', false]]);
  assert.ok(!output.scan.warnings.length, 'the app shows the assumed day; the service adds no warning');
  // אותו תאריך בשתי הקריאות — גם כשהן נבדלות ברווח בלבד — הוא תאריך מאושר.
  const same = await request([answer(doc()), answer(doc({ docDate: ' 7.9.2026 ' }))], input, {}, APP_142);
  assert.deepEqual(same.output.consensus.diffs, []);
  assert.deepEqual(same.output.consensus.docDateUnconfirmed, []);
  // קריאה שלא קראה תאריך כלל אינה מאשרת את התאריך שנבחר.
  const unread = await request([answer(doc()), answer(doc({ docDate: null }))], input, {}, APP_142);
  assert.equal(unread.calls.length, 2);
  assert.deepEqual(unread.output.consensus.docDateUnconfirmed, [0]);
});

test('v18: after an escalation the date is measured against every witness, like the disputed rows', async () => {
  const dated = (value, docDate) => doc({ ...value, docDate });
  // ההכרעה נבחרה (שוויון בנייר) וקראה את התאריך כמו הקריאה הזולה הראשונה: מאושר.
  const confirmed = await request([answer(dated(shiftedCodes, '7.9.2026')), answer(dated(shiftedCodesOther, '1.9.2026')), answer(dated(shiftedCodes, '7.9.2026'))], input, {}, APP_142);
  assert.equal(confirmed.calls.length, 3);
  assert.equal(confirmed.output.consensus.escalationSelected, true);
  assert.deepEqual(confirmed.output.consensus.docDateUnconfirmed, []);
  // ההכרעה קראה תאריך שלישי: אף עד אינו מאשר אותו, והוא מוחזר כפי שנקרא.
  const third = await request([answer(dated(shiftedCodes, '7.9.2026')), answer(dated(shiftedCodesOther, '1.9.2026')), answer(dated(shiftedCodes, '9.9.2026'))], input, {}, APP_142);
  assert.equal(third.output.consensus.escalationSelected, true);
  assert.deepEqual(third.output.consensus.docDateUnconfirmed, [0]);
  assert.equal(third.output.scan.documents[0].docDate, '9.9.2026');
  // קריאה זולה נבחרה כי הנייר שלה נסגר טוב יותר; ההכרעה היא עדה לתאריך שלה —
  // או חולקת עליו יחד עם הקריאה הזולה השנייה.
  const strongWorse = docDate => answer(doc({ ...shiftedCodes, subtotalExVat: 79, docDate }));
  const witnessed = await request([answer(dated(shiftedCodes, '7.9.2026')), answer(dated(shiftedCodesOther, '1.9.2026')), strongWorse('7.9.2026')], input, {}, APP_142);
  assert.equal(witnessed.output.consensus.escalationSelected, false);
  assert.equal(witnessed.output.scan.documents[0].docDate, '7.9.2026');
  assert.deepEqual(witnessed.output.consensus.docDateUnconfirmed, []);
  const outvoted = await request([answer(dated(shiftedCodes, '7.9.2026')), answer(dated(shiftedCodesOther, '1.9.2026')), strongWorse('1.9.2026')], input, {}, APP_142);
  assert.equal(outvoted.output.consensus.escalationSelected, false);
  assert.equal(outvoted.output.scan.documents[0].docDate, '7.9.2026');
  assert.deepEqual(outvoted.output.consensus.docDateUnconfirmed, [0]);
});

test('v18: a checksum retry that wins with its own date is measured against both cheap reads', async () => {
  // שתי הקריאות הזולות הסכימו על נייר שאינו נסגר ועל התאריך; קריאת ההצלה ניצחה עם תאריך אחר.
  const { output, calls } = await request([...agreed(doc({ subtotalExVat: 49 })), answer(doc({ docDate: '1.9.2026' }))]);
  assert.equal(calls.length, 3);
  assert.equal(output.checksumRetryAttempted, true);
  assert.equal(output.scan.documents[0].docDate, '1.9.2026');
  assert.deepEqual(output.consensus.docDateUnconfirmed, [0]);
  // וכשקריאת ההצלה קראה את אותו תאריך — שתי העדות מאשרות אותו.
  const same = await request([...agreed(doc({ subtotalExVat: 49 })), answer(doc())]);
  assert.equal(same.output.checksumRetryAttempted, true);
  assert.deepEqual(same.output.consensus.docDateUnconfirmed, []);
});

test('v18: the unconfirmed date is read from the documents, not from the capped diff list', () => {
  // התעודה הראשונה שונה ב-250 קודים, ולכן diffs נקטע לפני התאריך של התעודה השנייה.
  const many = prefix => Array.from({ length: 250 }, (unused, index) => row({ code: prefix + index, lineNumber: index + 1 }));
  const selected = { documents: [doc({ rows: many('A') }), doc({ noteIndex: 1 })], warnings: [] };
  const other = { documents: [doc({ rows: many('B') }), doc({ noteIndex: 1, docDate: '1.9.2026' })], warnings: [] };
  const capped = scanConsensusDiff(selected, other);
  assert.equal(capped.length, 200);
  assert.ok(!capped.some(diff => diff.field === 'docDate'));
  assert.deepEqual(scanConsensusDocDateUnconfirmed(selected, [other]), [1]);
  // עד אחד שמאשר מספיק, גם כשאחר חולק; עד שלא קרא את המסמך אינו מאשר.
  assert.deepEqual(scanConsensusDocDateUnconfirmed(selected, [other, selected]), []);
  assert.deepEqual(scanConsensusDocDateUnconfirmed(selected, [{ documents: [doc()], warnings: [] }]), [1]);
  // בלי עדים אין מי שחולק: זה המקרה של unverifiedSingleRead, לא של התאריך.
  assert.deepEqual(scanConsensusDocDateUnconfirmed(selected, []), []);
  assert.deepEqual(scanConsensusDocDateUnconfirmed(selected, [null]), []);
});

test('v18: the same day read in two formats is a confirmed date; diffs still report the difference', async () => {
  const read = docDate => scan(doc({ docDate }));
  // אותו יום בלוח: מפריד אחר, שנה בשתי ספרות, אפס מוביל, או ISO.
  for (const [a, b] of [['17/09/2026', '17.09.2026'], ['17/09/26', '17/09/2026'], ['7.9.2026', '07.09.2026'],
    ['17-09-2026', '2026-09-17'], ['1.10.26', '01/10/2026']]) {
    assert.deepEqual(scanConsensusDocDateUnconfirmed(read(a), [read(b)]), [], a + ' / ' + b);
    assert.deepEqual(scanConsensusDocDateUnconfirmed(read(b), [read(a)]), [], b + ' / ' + a);
    // ההשוואה בין הקריאות וכללי ההסלמה אינם משתנים: הצורה השונה נשארת הבדל מידע.
    assert.deepEqual(scanConsensusDiff(read(a), read(b)).map(diff => [diff.field, diff.trigger]), [['docDate', false]]);
  }
  // יום אחר, או תאריך שאינו קיים בלוח (31/09, חודש 17), אינו מאשר. כשצד אחד
  // אינו מתפענח — המחרוזות מושוות כמו קודם.
  for (const [a, b] of [['17/09/2026', '18.09.2026'], ['17/09/2026', '17/09/2025'], ['17/09/2026', '09/17/2026'],
    ['31/09/2026', '1/10/2026'], ['17/09/2026', 'ספטמבר 17'], ['17/09/2026', null]]) {
    assert.deepEqual(scanConsensusDocDateUnconfirmed(read(a), [read(b)]), [0], a + ' / ' + b);
  }
  assert.deepEqual(scanConsensusDocDateUnconfirmed(read('ספטמבר 17'), [read(' ספטמבר 17 ')]), []);
  // מקצה לקצה (אפליקציה 142): שתי הקריאות קראו את אותו יום בשתי צורות — אין הסלמה ואין מחלוקת.
  const { output, calls } = await request([answer(doc({ docDate: '17/09/2026' })), answer(doc({ docDate: '17.09.2026' }))], input, {}, APP_142);
  assert.equal(calls.length, 2);
  assert.equal(output.consensus.agreed, true);
  assert.deepEqual(output.consensus.diffs.map(diff => diff.field), ['docDate']);
  assert.deepEqual(output.consensus.docDateUnconfirmed, []);
  assert.equal(output.scan.documents[0].docDate, '17/09/2026', 'the printed value is returned as read');
});

test('v18: money, identity and the promotion star still escalate', async () => {
  for (const other of [doc({ subtotalExVat: 50.5 }), doc({ promoDiscountExVat: 1 }), doc({ rows: [row({ lineTotalExVat: 50.1 })] }),
    doc({ rows: [row({ code: '9' })] }), doc({ rows: [row({ promoStar: true })] }), doc({ docDate: '1.9.2026', rows: [row({ quantity: 11 })] })]) {
    const { output, calls } = await request([answer(doc()), answer(other), answer(doc())]);
    assert.equal(calls.length, 3, JSON.stringify(other));
    assert.equal(calls[2].model, 'gpt-5.6-terra');
    assert.equal(output.consensus.agreed, false);
    assert.equal(output.consensus.reason, 'reads_disagree');
    assert.equal(output.consensus.escalated, true);
  }
});

test('v18: the strong read gets the places the reads disagreed on, never the values they read', async () => {
  // הקריאה השנייה קראה בשורה 2 קוד, כמות וסכום אחרים, ולכן גם סיכום אחר — ותאריך אחר.
  const other = paper(fourRows().map((item, index) => index === 1 ? row({ ...item, code: '229', quantity: 7, lineTotalExVat: 35 }) : item));
  for (const extraBody of [APP_142, {}]) {
    const label = JSON.stringify(extraBody);
    const { output, calls } = await request([answer(fourRowPaper), answer(doc({ ...other, docDate: '1.9.2026' })), answer(fourRowPaper)], input, {}, extraBody);
    assert.equal(calls.length, 3, label);
    assert.equal(output.consensus.agreed, false, label);
    const note = calls[2].input[1].content.at(-1).text;
    // בלי הדגל התאריך מסלים כמו בשירות 17, ולכן שמו — רק שמו — נמסר לקריאת ההכרעה.
    assert.ok(note.includes(extraBody.strongReadSelection ? 'מסמך noteIndex=0: subtotalExVat.' : 'מסמך noteIndex=0: docDate, subtotalExVat.'), note);
    assert.ok(note.includes('מסמך noteIndex=0, עמוד 1, שורה 2: code, quantity, lineTotalExVat.'), note);
    assert.ok(note.includes('באופן עצמאי'));
    assert.ok(note.includes('עמודת הקוד נקראת בהסטה של שורה אחת'));
    assert.ok(note.includes('שווה למונה "פריטים" המודפס'));
    // אף ערך שנקרא: לא הקודים, לא הכמות והסכומים, לא הסיכום, לא התאריך — ולא שדות מידע.
    for (const value of ['222', '229', '35', '96', '91', '₪', 'נקרא פעם', '1.9.2026', '7.9.2026', 'vatAmount', 'totalInclVat']) {
      assert.ok(!note.includes(value), label + ' ' + value);
    }
    if (extraBody.strongReadSelection) assert.ok(!note.includes('docDate'), note);
    // קריאת ההכרעה עצמה רואה את אותם צילומים ואת אותן הנחיות כמו הקריאות הזולות.
    assert.deepEqual(calls[2].input[0], calls[0].input[0]);
    assert.deepEqual(calls[2].input[1].content.slice(0, -1), calls[0].input[1].content);
  }
});

test('v18: a cheap read that closes the paper better is selected, and the strong read becomes its witness', async () => {
  // ההכרעה קראה את הקוד כמו הקריאה הראשונה, אבל את "סהכ חייב מעמ" בטעות.
  const strongWorse = doc({ ...shiftedCodes, subtotalExVat: 79 });
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(strongWorse)], input, {}, APP_142);
  assert.equal(calls.length, 3, 'the selected read closes the paper, so there is no checksum retry');
  assert.equal(output.consensus.escalated, true);
  assert.equal(output.consensus.escalationModel, 'gpt-5.6-terra');
  assert.equal(output.consensus.escalationSelected, false);
  assert.equal(output.model, 'gpt-5.6-luna');
  assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected, a.paperError]),
    [['consensus_1', true, 0], ['consensus_2', false, 0], ['consensus_escalation', false, 2]]);
  assert.equal(output.scan.documents[0].subtotalExVat, 80);
  assert.equal(output.paperValidation[0].ok, true);
  assert.equal(output.checksumRetryAttempted, false);
  // הקוד של הקריאה שנבחרה מאושר בידי ההכרעה — היא עדה, לא מנצחת.
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, item.fields]),
    [[1, [{ field: 'code', selected: '222', other: '111', confirmed: 1 }]]]);
  assert.ok(!output.scan.warnings.some(warning => warning.includes('אישור ידני')));
  assert.equal(output.consensus.unverifiedSingleRead, false);
});

test('v18: an equal paper error is a tie, and a tie goes to the strong read', async () => {
  // שלוש הקריאות קראו את אותו סיכום שגוי: הנייר של כולן רחוק באותה מידה.
  const wrong = value => doc({ ...value, subtotalExVat: 79 });
  const thirdReading = doc({ ...shiftedCodes, rows: [shiftedCodes.rows[0], row({ ...shiftedCodes.rows[1], code: '333' })] });
  const { output, calls } = await request([answer(wrong(shiftedCodes)), answer(wrong(shiftedCodesOther)), answer(wrong(thirdReading)), answer(wrong(thirdReading))], input, {}, APP_142);
  assert.equal(calls.length, 4, 'escalation, then the checksum retry of the selected read');
  assert.deepEqual(output.scanAudit.attempts.slice(0, 3).map(a => a.paperError), [2, 2, 2]);
  assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
    [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true], ['checksum_retry', false]]);
  assert.equal(output.consensus.escalationSelected, true);
  assert.equal(output.scan.documents[0].rows[1].code, '333');
  assert.equal(output.model, 'gpt-5.6-terra');
});

test('v18: reads one agora off in opposite directions tie, and the tie still goes to the strong read', async () => {
  // סיכום מודפס 96.29. ההכרעה קראה 96.28, הקריאה הזולה הראשונה 96.30 — שתיהן
  // רחוקות אגורה אחת. בשקלים עשרוניים ההפרשים יוצאים 0.01000000000000512
  // ו-0.009999999999990905, והקריאה הזולה "ניצחה" שוויון. המדד באגורות שלמות.
  const off = (price, code = '8') => doc({ subtotalExVat: 96.29, rows: [row({ code, quantity: 1, unitPriceExVat: price, lineTotalExVat: price })] });
  const { output, calls } = await request([answer(off(96.30)), answer(off(96.31, '9')), answer(off(96.28)), answer(off(96.28))], input, {}, APP_142);
  assert.equal(calls.length, 4, 'escalation, then the checksum retry of the selected read');
  assert.deepEqual(output.scanAudit.attempts.slice(0, 3).map(a => [a.stage, a.paperError]),
    [['consensus_1', 1.01], ['consensus_2', 1.02], ['consensus_escalation', 1.01]]);
  assert.deepEqual(output.scanAudit.attempts.map(a => a.selected), [false, false, true, false]);
  assert.equal(output.consensus.escalationSelected, true);
  assert.equal(output.model, 'gpt-5.6-terra');
  assert.equal(output.scan.documents[0].rows[0].lineTotalExVat, 96.28);
});

test('v18: with a typed anchor the reads are ranked by the printed paper, not by how close they come to the anchor', async () => {
  // הוקלדו 95 ו-2 שורות, אבל הנייר: שתי שורות של 50 וסיכום מודפס 100. קריאה זולה
  // אחת וההכרעה קראו נכון (רחוקות 5 מהעוגן); השנייה קראה 47 בשורה 2 (רחוקה 2 בלבד).
  // לפי העוגן הקריאה השגויה הייתה נבחרת, עוקפת את עצירת העוגן השגוי ועולה קריאת הצלה.
  const typed = [{ ...input[0], expectedSubtotalExVat: 95, expectedLines: 2 }];
  const right = doc({ itemsPrintedLines: 2, subtotalExVat: 100, rows: [row({ code: '111' }), row({ code: '222', lineNumber: 2 })] });
  const misread = doc({ ...right, rows: [right.rows[0], row({ code: '229', lineNumber: 2, unitPriceExVat: 4.7, lineTotalExVat: 47 })] });
  const { output, calls } = await request([answer(right), answer(misread), answer(right)], typed, {}, APP_142);
  assert.equal(calls.length, 3, 'no checksum retry against a typed anchor the paper disproves');
  assert.equal(output.ok, false);
  assert.equal(output.error, 'anchor_mismatch_printed');
  assert.ok(output.message.includes('₪100.00'), output.message);
  assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected, a.paperError]),
    [['consensus_1', false, 0], ['consensus_2', false, 4], ['consensus_escalation', true, 0]]);
  // ועם עוגן נכון: קריאה זולה שנסגרת מול הנייר גוברת על הכרעה שקראה את הסיכום בטעות,
  // ומשם הכול כרגיל — העוגן מאושר, אין קריאת הצלה, וההכרעה עדה לקוד שנבחר.
  const anchored = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(doc({ ...shiftedCodes, subtotalExVat: 79 }))],
    [{ ...input[0], expectedSubtotalExVat: 80, expectedLines: 2 }], {}, APP_142);
  assert.equal(anchored.calls.length, 3);
  assert.equal(anchored.output.ok, true);
  assert.equal(anchored.output.consensus.escalationSelected, false);
  assert.equal(anchored.output.model, 'gpt-5.6-luna');
  assert.equal(anchored.output.checksumRetryAttempted, false);
  assert.deepEqual(anchored.output.scanAudit.attempts.map(a => [a.selected, a.paperError]), [[true, 0], [false, 0], [false, 2]]);
  assert.deepEqual(anchored.output.consensus.disputedRows.map(item => item.fields), [[{ field: 'code', selected: '222', other: '111', confirmed: 1 }]]);
});

test('v18: reads that did not read the printed summary tie, instead of the read with fewer rows winning', async () => {
  // בלי סיכום ובלי מונה מודפסים אין מול מה למדוד את סכום השורות ואת מספרן — אחרת
  // הקריאה שהשמיטה שורה "קרובה" יותר לאפס ונבחרת.
  const blind = rows => doc({ itemsPrintedLines: null, subtotalExVat: null, rows });
  const { output, calls } = await request([answer(blind([row()])), answer(blind([row({ code: '9' })])),
    answer(blind([row(), row({ code: '7', lineNumber: 2 })]))], input, {}, APP_142);
  assert.equal(calls.length, 3, 'a missing summary asks for a photo, not a paid reread');
  assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
    [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true]]);
  const errors = output.scanAudit.attempts.map(a => a.paperError);
  assert.ok(errors.every(value => Number.isFinite(value) && value > 0), 'every read was measured, and none closed');
  assert.equal(new Set(errors).size, 1);
  assert.equal(output.consensus.escalationSelected, true);
  assert.equal(output.scan.documents[0].rows.length, 2);
  assert.equal(output.paperValidation[0].missingSummary, true);
});

// ===== v18: הבחירה לפי הנייר היא חוזה עם הלקוח, לא ברירת מחדל =====
// אפליקציה ישנה (עד 141) מנסחת כל מחלוקת שהוסלמה כהכרעת המודל היקר. אצלה קריאת
// ההכרעה שהושלמה מנצחת תמיד, כמו בשירות 16/17, וסדר הפריסה אינו משנה עוד.
// ההכרעה קראה קוד שלישי ולא קראה את "סהכ חייב מעמ"; הקריאה הזולה הראשונה נסגרת מול הנייר.
const strongLostSummary = doc({ ...shiftedCodes, subtotalExVat: null,
  rows: [shiftedCodes.rows[0], row({ ...shiftedCodes.rows[1], code: '333' })] });
test('v18: without strongReadSelection:true a completed escalation wins, exactly as before', async () => {
  for (const extraBody of [{}, { strongReadSelection: false }, { strongReadSelection: 'true' }, { strongReadSelection: 1 }, { strongReadSelection: null }]) {
    const label = JSON.stringify(extraBody);
    const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(strongLostSummary)], input, {}, extraBody);
    assert.equal(calls.length, 3, label + ': a missing summary buys no checksum retry');
    assert.equal(output.ok, true, label);
    assert.equal(output.consensus.strongReadSelection, false, label);
    assert.equal(output.consensus.escalated, true, label);
    assert.equal(output.consensus.escalationSelected, true, label);
    assert.equal(output.model, 'gpt-5.6-terra', label);
    assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
      [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true]], label);
    assert.ok(output.scanAudit.attempts.every(a => !('paperError' in a)), label + ': nothing was ranked');
    assert.equal(output.scan.documents[0].rows[1].code, '333', label);
    assert.equal(output.paperValidation[0].missingSummary, true, label);
    // מה שבטוח לאפליקציה ישנה נשאר: ההנחיה בלי ערכים, והשורה שבמחלוקת נמדדת מול שתי הזולות.
    const note = calls[2].input[1].content.at(-1).text;
    assert.ok(note.includes('שורה 2: code.') && !note.includes('222') && !note.includes('111'), label);
    assert.deepEqual(output.consensus.disputedRows.map(item => item.fields),
      [[{ field: 'code', selected: '333', other: '222', confirmed: 0 }]], label);
    assert.equal(output.consensus.unverifiedSingleRead, false, label);
  }
  // אותו צילום מאפליקציה 142: הקריאה הזולה שנסגרת מול הנייר נבחרת, וההכרעה עדה לה.
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(strongLostSummary)], input, {}, APP_142);
  assert.equal(calls.length, 3);
  assert.equal(output.consensus.strongReadSelection, true);
  assert.equal(output.consensus.escalated, true);
  assert.equal(output.consensus.escalationSelected, false);
  assert.equal(output.model, 'gpt-5.6-luna');
  assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected, a.paperError]),
    [['consensus_1', true, 0], ['consensus_2', false, 0], ['consensus_escalation', false, 1000001]], 'the fixed penalty for an unread summary, plus its one problem');
  assert.equal(output.scan.documents[0].rows[1].code, '222');
  assert.equal(output.paperValidation[0].ok, true);
  assert.deepEqual(output.consensus.disputedRows.map(item => item.fields),
    [[{ field: 'code', selected: '222', other: '111', confirmed: 0 }]]);
});

test('v18: without the flag escalationSelected stays truthful when a checksum retry replaces the escalation', async () => {
  // ההכרעה קראה את "סהכ חייב מעמ" בטעות. בלי הדגל היא נבחרת כמו קודם, הנייר שלה
  // אינו נסגר, וקריאת ההצלה של סכום הביקורת מחליפה אותה — כמו בשירות 16/17.
  const strongWorse = doc({ ...shiftedCodes, subtotalExVat: 79 });
  const old = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(strongWorse), answer(shiftedCodes)]);
  assert.equal(old.calls.length, 4, 'escalation, then the checksum retry of the escalation read');
  assert.equal(old.output.consensus.escalated, true);
  assert.equal(old.output.consensus.escalationSelected, false, 'the checksum retry is the read returned');
  assert.equal(old.output.checksumRetryAttempted, true);
  assert.deepEqual(old.output.scanAudit.attempts.map(a => [a.stage, a.selected, a.paperError]),
    [['consensus_1', false, undefined], ['consensus_2', false, undefined], ['consensus_escalation', false, undefined], ['checksum_retry', true, undefined]]);
  assert.equal(old.output.scan.documents[0].subtotalExVat, 80);
  // והמעבר ישירות: הסלמה שנבחרה ונסגרת מול הנייר.
  const closed = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(shiftedCodes)]);
  assert.equal(closed.calls.length, 3);
  assert.equal(closed.output.consensus.escalationSelected, true);
  // עם הדגל אותו צילום נסגר בקריאה הזולה, בלי לשלם על קריאת הצלה.
  const fresh = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(strongWorse)], input, {}, APP_142);
  assert.equal(fresh.calls.length, 3);
  assert.equal(fresh.output.consensus.escalationSelected, false);
  assert.equal(fresh.output.checksumRetryAttempted, false);
});

test('v18: agreeing reads, a failed escalation and a lone read do not depend on the flag', async () => {
  for (const extraBody of [{}, APP_142]) {
    const label = JSON.stringify(extraBody);
    const agreedRun = await request([answer(doc()), answer(doc({ vatAmount: 9.01, totalInclVat: 59.01 }))], input, {}, extraBody);
    assert.equal(agreedRun.calls.length, 2, label + ': an information-only difference never escalates');
    assert.equal(agreedRun.output.consensus.agreed, true, label);
    assert.equal(agreedRun.output.consensus.escalationSelected, false, label);
    // התאריך שאף קריאה אינה מאשרת נמסר בשני המקרים. בלי הדגל הוא מסלים קודם, כמו
    // בשירות 17, וכאן קריאת ההכרעה קראה תאריך שלישי.
    const dateRun = await request([answer(doc()), answer(doc({ docDate: '1.9.2026' })), answer(doc({ docDate: '9.9.2026' }))], input, {}, extraBody);
    assert.equal(dateRun.calls.length, extraBody.strongReadSelection ? 2 : 3, label);
    assert.deepEqual(dateRun.output.consensus.docDateUnconfirmed, [0], label);
    assert.equal(dateRun.output.consensus.escalationSelected, !extraBody.strongReadSelection, label);
    const failed = await request([answer(shiftedCodes), answer(shiftedCodesOther), new Error('test network failure')], input, {}, extraBody);
    assert.equal(failed.output.consensus.escalationSelected, false, label);
    assert.equal(failed.output.scan.documents[0].rows[1].code, '222', label);
    assert.equal(failed.output.consensus.disputedRows.length, 1, label);
    const drop = () => new Error('test network failure');
    const lone = await request([answer(doc()), drop(), drop(), drop()], input, {}, extraBody);
    assert.equal(lone.output.consensus.unverifiedSingleRead, true, label);
    assert.ok(lone.output.scan.warnings.some(warning => warning.startsWith('רק קריאה אחת של הצילום הושלמה')), label);
  }
});

// ===== מיזוג: שירות 17 (אין מספר תעודה, כותרת חתוכה, סימן הזיכוי) חי בתוך שירות 18 =====
test('v18 after the merge: no document number, a cut header and a credit sign behave as in service 17, under both flags', async () => {
  // הסכמה אינה מבקשת מספר תעודה, ואינה מכירה "unknown".
  const schema = (await request(agreed(doc()))).calls[0].text.format.schema.properties.documents.items;
  assert.ok(!('docNumber' in schema.properties) && !schema.required.includes('docNumber'));
  assert.deepEqual(schema.properties.docType.enum, ['invoice', 'credit']);
  const { docNumber: unusedNumber, ...noNumber } = doc();
  for (const extraBody of [{}, APP_142]) {
    const label = JSON.stringify(extraBody);
    // כותרת שנחתכה בקריאה אחת: אין מחלוקת על הכותרת, והתעודה נקלטת. התאריך שנחתך
    // יחד איתה — באפליקציה 142 מידע בלבד, והלקוח יודע שאינו מאושר; באפליקציה ישנה
    // הוא מסלים כמו בשירות 17, וקריאת ההכרעה (שקראה את הכותרת) מכריעה אותו.
    const fresh = extraBody.strongReadSelection === true;
    const cut = await request([answer(doc({ docNumber: '561011080' })), answer({ ...noNumber, docType: 'unknown', docDate: null }), answer(doc())], input, {}, extraBody);
    assert.equal(cut.calls.length, fresh ? 2 : 3, label + ': a cut header costs no paid read; only the date can');
    assert.equal(cut.output.ok, true, label);
    assert.equal(cut.output.consensus.agreed, fresh, label);
    assert.deepEqual(cut.output.consensus.diffs.map(diff => [diff.field, diff.trigger]), [['docDate', fresh ? false : undefined]], label);
    assert.deepEqual(cut.output.consensus.docDateUnconfirmed, fresh ? [0] : [], label);
    assert.equal(cut.output.paperValidation[0].receivable, true, label);
    assert.deepEqual(cut.output.paperValidation[0].review, [], label);
    assert.equal(cut.output.scanAudit.result, 'paper_verified', label);
    // כותרת שלא נקראה בשתי הקריאות, בלי מספר תעודה כלל: תעודה רגילה.
    const both = await request(agreed({ ...noNumber, docType: 'unknown' }), input, {}, extraBody);
    assert.equal(both.calls.length, 2, label);
    assert.equal(both.output.paperValidation[0].receivable, true, label);
    // זיכוי שכותרתו נחתכה נעצר לפי המינוס, בלי קריאת הצלה בתשלום.
    const minus = doc({ docType: 'invoice', subtotalExVat: -50, vatAmount: -9, totalInclVat: -59 });
    const credit = await request(agreed(minus), input, {}, extraBody);
    assert.equal(credit.calls.length, 2, label + ': the minus is not "fixed" by a paid retry');
    assert.equal(credit.output.checksumRetryAttempted, false, label);
    assert.equal(credit.output.paperValidation[0].ok, true, label);
    assert.equal(credit.output.paperValidation[0].receivable, false, label);
    assert.match(credit.output.paperValidation[0].review.join(' '), /כנראה חשבונית זיכוי/, label);
    assert.equal(credit.output.scan.documents[0].subtotalExVat, -50, label);
    // מינוס שנקרא רק בקריאה אחת הוא הבדל בכסף, ולכן עדיין מסלים.
    const oneMinus = await request([answer(minus), answer(doc()), answer(minus)], input, {}, extraBody);
    assert.equal(oneMinus.calls.length, 3, label);
    assert.ok(oneMinus.output.consensus.diffs.some(diff => diff.field === 'subtotalExVat' && diff.trigger === undefined), label);
    assert.equal(oneMinus.output.paperValidation[0].receivable, false, label);
    // זיכוי שנראה בקריאה אחת בלבד מסלים, וההנחיה נותנת את שם השדה — לא את הקריאות.
    const titled = doc({ docType: 'credit', subtotalExVat: -50, vatAmount: -9, totalInclVat: -59 });
    const creditRun = await request([answer(titled), answer({ ...noNumber, docType: 'unknown' }), answer(titled)], input, {}, extraBody);
    assert.equal(creditRun.calls.length, 3, label);
    const note = creditRun.calls[2].input[1].content.at(-1).text;
    // המע"מ והסכום כולל מע"מ נקראו כאן בסימנים שונים — הבדל בסימן מסלים, ולכן גם שמם נמסר.
    assert.ok(note.includes('מסמך noteIndex=0: docType, subtotalExVat, vatAmount, totalInclVat.'), note);
    assert.ok(!/credit|invoice|unknown|-50|-59|₪/.test(note), note);
    assert.equal(creditRun.output.consensus.escalationSelected, true, label + ': both close; the tie goes to the strong read');
    assert.match(creditRun.output.paperValidation[0].review.join(' '), /זו חשבונית זיכוי/, label);
    // נייר מעורב שההחזרות בו גדולות מהסחורה נסגר בסימן שלו.
    const mixed = doc({ itemsSectionTotalExVat: 50, returnsSectionTotalExVat: 80, returnsPrintedLines: 1, subtotalExVat: -30, vatAmount: -5.4, totalInclVat: -35.4,
      rows: [row(), row({ section: 'returns', quantity: 16, lineTotalExVat: 80 })] });
    const mixedRun = await request(agreed(mixed), input, {}, extraBody);
    assert.equal(mixedRun.calls.length, 2, label);
    assert.equal(mixedRun.output.checksumRetryAttempted, false, label);
    assert.equal(mixedRun.output.paperValidation[0].ok, true, label);
    assert.equal(mixedRun.output.paperValidation[0].receivable, false, label);
  }
});

// ===== מיזוג: סימן הזיכוי על המע"מ ועל הסכום כולל מע"מ =====
// משירות 17 מינוס על סכום המע"מ או על הסכום כולל מע"מ מסמן זיכוי גם כשהכותרת
// נחתכה. הבדל בערך של השדות האלה הוא מידע בלבד (שירות 18), אבל הבדל בסימן הוא
// ההבדל בין קליטת סחורה לזיכוי — ולכן מסלים, כמו בשירות 17.
test('v18: a minus only one read saw on the VAT or the total still escalates, in either order, under both flags', async () => {
  const plain = doc();
  const signed = doc({ vatAmount: -9, totalInclVat: -59 });
  const marks = (a, b) => scanConsensusDiff(scan(a), scan(b)).map(diff => [diff.field, diff.trigger ?? true]);
  assert.deepEqual(marks(plain, signed), [['vatAmount', true], ['totalInclVat', true]]);
  assert.deepEqual(marks(signed, plain), [['vatAmount', true], ['totalInclVat', true]]);
  assert.deepEqual(marks(doc({ totalInclVat: -59 }), plain), [['totalInclVat', true]]);
  assert.deepEqual(marks(doc({ vatAmount: null }), doc({ vatAmount: -9 })), [['vatAmount', true]], 'a value not read is not a minus');
  // אותו סימן — מידע בלבד, כמו קודם.
  assert.deepEqual(marks(plain, doc({ vatAmount: 9.01, totalInclVat: 59.01 })), [['vatAmount', false], ['totalInclVat', false]]);
  assert.deepEqual(marks(signed, doc({ vatAmount: -9.01, totalInclVat: -59.01 })), [['vatAmount', false], ['totalInclVat', false]]);
  assert.deepEqual(marks(doc({ vatAmount: null }), plain), [['vatAmount', false]]);
  for (const extraBody of [{}, APP_142]) {
    for (const [first, second] of [[plain, signed], [signed, plain]]) {
      const label = JSON.stringify(extraBody) + ' consensus_1 vat ' + first.vatAmount;
      const { output, calls } = await request([answer(first), answer(second), answer(signed)], input, {}, extraBody);
      assert.equal(calls.length, 3, label + ': the sign difference escalates');
      assert.equal(output.consensus.agreed, false, label);
      assert.equal(output.consensus.reason, 'reads_disagree', label);
      assert.deepEqual(output.consensus.diffs.map(diff => [diff.field, diff.trigger]), [['vatAmount', undefined], ['totalInclVat', undefined]], label);
      assert.equal(output.consensus.escalationSelected, true, label + ': every paper closes, so the strong read decides');
      assert.equal(output.scan.documents[0].vatAmount, -9, label);
      assert.equal(output.paperValidation[0].receivable, false, label);
      assert.match(output.paperValidation[0].review.join(' '), /כנראה חשבונית זיכוי/, label);
      const note = calls[2].input[1].content.at(-1).text;
      assert.ok(note.includes('מסמך noteIndex=0: vatAmount, totalInclVat.'), note);
      assert.ok(!note.includes('-9') && !note.includes('-59'), note);
    }
  }
  // הבדל ערך באותו סימן עדיין אינו עולה קריאה.
  const value = await request([answer(signed), answer(doc({ vatAmount: -9.01, totalInclVat: -59.01 }))]);
  assert.equal(value.calls.length, 2);
  assert.equal(value.output.consensus.agreed, true);
  assert.equal(value.output.paperValidation[0].receivable, false);
});

// ===== מיזוג: מדד הנייר אינו מעניש קריאה ששמרה את המינוס =====
// זיכוי עם כותרת חתוכה, סיכום -80 ושתי שורות. בדיקת הנייר של שירות 17 סוגרת אותו
// בערך מוחלט; המדד שמשווה קריאות חייב למדוד מול אותו סכום, אחרת קריאה ששמרה את
// המינוס ונכשלה בדבר אחר "רחוקה" 160 ₪, וקריאה שהשמיטה אותו נבחרת.
const creditPaper = (quantities, sign = -1) => doc({ itemsPrintedLines: 2, subtotalExVat: 80 * sign, vatAmount: 14.4 * sign, totalInclVat: 94.4 * sign,
  rows: quantities.map((quantity, index) => row({ code: String(111 * (index + 1)), lineNumber: index + 1, quantity, lineTotalExVat: 40 })) });
test('v18: keeping the minus costs no paper error, also when the paper fails for another reason', async () => {
  const keptOne = creditPaper([9, 8]);
  const mismatch = scanChecksumMismatches(scan(keptOne), input);
  assert.equal(mismatch.length, 1);
  assert.deepEqual([mismatch[0].got, mismatch[0].expected], [80, 80], 'measured against the amount the paper closes on');
  assert.equal(tnuvaPaperCheck(keptOne, 1).amount, -80, 'the printed amount is still returned with its sign');
  assert.equal(tnuvaPaperCheck(keptOne, 1).checkedAmount, 80);
  // נייר מעורב שההחזרות בו גדולות מהסחורה נסגר בסימן שלו, ונמדד מולו.
  const mixed = doc({ itemsSectionTotalExVat: 50, returnsSectionTotalExVat: 80, returnsPrintedLines: 1, subtotalExVat: -30, vatAmount: -5.4, totalInclVat: -35.4,
    rows: [row({ quantity: 11 }), row({ section: 'returns', quantity: 16, lineTotalExVat: 80 })] });
  assert.deepEqual(scanChecksumMismatches(scan(mixed), input).map(item => [item.got, item.expected]), [[-30, -30]]);
  assert.equal(tnuvaPaperCheck(doc(), 1).checkedAmount, 50);
  assert.equal(tnuvaPaperCheck(doc({ subtotalExVat: null }), 1).checkedAmount, null);
  // הקריאה ששמרה את המינוס עם פחות בעיות גוברת על זו שהשמיטה אותו — עם הדגל ובלעדיו.
  const dropped = creditPaper([9, 9], 1);
  const strong = creditPaper([8, 9]);
  for (const extraBody of [{}, APP_142]) {
    const label = JSON.stringify(extraBody);
    const { output, calls } = await request([answer(keptOne), answer(dropped), answer(strong), answer(keptOne)], input, {}, extraBody);
    assert.equal(calls.length, 4, label + ': escalation, then the checksum retry of the selected read');
    assert.equal(output.consensus.escalationSelected, true, label);
    assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
      [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true], ['checksum_retry', false]], label);
    if (extraBody.strongReadSelection) assert.deepEqual(output.scanAudit.attempts.slice(0, 3).map(a => a.paperError), [1, 2, 1], label);
    assert.equal(output.scan.documents[0].subtotalExVat, -80, label);
    assert.match(output.paperValidation[0].review.join(' '), /כנראה חשבונית זיכוי/, label);
  }
  // וגם קריאת ההצלה של סכום הביקורת: קריאה חוזרת שהשמיטה את המינוס, עם אותו מספר
  // בעיות, אינה גוברת על הקריאה ששמרה אותו (שירות 17: קריאה חוזרת אינה "מתקנת" מינוס).
  const retried = await request([...agreed(keptOne), answer(creditPaper([9, 8], 1))]);
  assert.equal(retried.calls.length, 3);
  assert.equal(retried.output.checksumRetryAttempted, true);
  assert.deepEqual(retried.output.scanAudit.attempts.map(a => [a.stage, a.selected]), [['consensus_1', true], ['consensus_2', false], ['checksum_retry', false]]);
  assert.equal(retried.output.scan.documents[0].subtotalExVat, -80);
  assert.match(retried.output.paperValidation[0].review.join(' '), /כנראה חשבונית זיכוי/);
});

// ===== מיזוג: תאריך התעודה מול אפליקציה ישנה =====
// אפליקציה 141 ומטה בודקת מבצעים (וכרטיס "המבצע לא הופעל") לפי docDate של הנייר
// כפי שהוא, ואינה מכירה את docDateUnconfirmed. בלי הדגל הבדל בתאריך מסלים כמו
// בשירות 17, וקריאת ההכרעה מכריעה אותו; רק אפליקציה 142, שיודעת לעבור להיום,
// חוסכת את הקריאה.
test('v18: without the flag a date difference escalates as in service 17; with it, it costs nothing', async () => {
  const dated = docDate => answer(doc({ docDate }));
  const old = await request([dated('17.10.2026'), dated('11.10.2026'), dated('11.10.2026')]);
  assert.equal(old.calls.length, 3, 'an old app gets the strong read to settle the date');
  assert.equal(old.output.consensus.agreed, false);
  assert.equal(old.output.consensus.reason, 'reads_disagree');
  assert.deepEqual(old.output.consensus.diffs, [{ noteIndex: 0, scope: 'document', field: 'docDate', values: ['17.10.2026', '11.10.2026'] }]);
  assert.equal(old.output.consensus.escalationSelected, true);
  assert.equal(old.output.scan.documents[0].docDate, '11.10.2026');
  assert.deepEqual(old.output.consensus.docDateUnconfirmed, [], 'the second cheap read confirms the date the strong read settled');
  const note = old.calls[2].input[1].content.at(-1).text;
  assert.ok(note.includes('מסמך noteIndex=0: docDate.'), note);
  assert.ok(!note.includes('17.10.2026') && !note.includes('11.10.2026'), note);
  // גם צורת כתיבה אחרת, וגם כותרת שנחתכה עם התאריך — כמו בשירות 17.
  const format = await request([dated('17/09/2026'), dated('17.09.2026'), dated('17/09/2026')]);
  assert.equal(format.calls.length, 3);
  const { docNumber: unusedNumber, ...noNumber } = doc();
  const cut = await request([answer(doc()), answer({ ...noNumber, docType: 'unknown', docDate: null }), answer(doc())]);
  assert.equal(cut.calls.length, 3);
  assert.deepEqual(cut.output.consensus.diffs.map(diff => [diff.field, diff.trigger]), [['docDate', undefined]], 'the cut type still costs nothing');
  assert.equal(cut.output.paperValidation[0].receivable, true);
  // עם הדגל: אין קריאה שלישית, ההבדל מסומן trigger:false, והאפליקציה יודעת שהתאריך אינו מאושר.
  const fresh = await request([dated('17.10.2026'), dated('11.10.2026')], input, {}, APP_142);
  assert.equal(fresh.calls.length, 2);
  assert.equal(fresh.output.consensus.agreed, true);
  assert.deepEqual(fresh.output.consensus.diffs, [{ noteIndex: 0, scope: 'document', field: 'docDate', values: ['17.10.2026', '11.10.2026'], trigger: false }]);
  assert.equal(fresh.output.scan.documents[0].docDate, '17.10.2026');
  assert.deepEqual(fresh.output.consensus.docDateUnconfirmed, [0]);
  // שאר שדות המידע אינם תלויים בדגל.
  for (const extraBody of [{}, APP_142]) {
    const vat = await request([answer(doc()), answer(doc({ vatPct: 17, vatAmount: 8.5, totalInclVat: 58.5, roundingDiff: .02 }))], input, {}, extraBody);
    assert.equal(vat.calls.length, 2, JSON.stringify(extraBody));
  }
});

// ===== v19: הקריאה החזקה השנייה =====
// הכרעת הבעלים: שדה ש-Terra אינו מסכים בו עם אף קריאה זולה מקבל קריאה חזקה שנייה,
// במשבצת של קריאת ההצלה. קראה אותו כמו Terra, והנייר מוכיח את עצמו — הוא מתקבל בלי
// העובד. הנייר כאן: ארבע שורות שנסגרות ב-91 ₪. שתי הקריאות הזולות קראו בשורה 2 כמות
// אחרת כל אחת (13 ו-17, והסכום בהתאם), ו-Terra קרא 6 — מה שמודפס.
const rowTwo = changes => doc({ ...fourRowPaper, rows: fourRows().map((item, index) => index === 1 ? row({ ...item, ...changes }) : item) });
const lunaThirteen = rowTwo({ quantity: 13, lineTotalExVat: 65 });
const lunaSeventeen = rowTwo({ quantity: 17, lineTotalExVat: 85 });
const SECOND_OFF = { SECOND_STRONG_READ: 'off' };
// מה ששירות 18 מחזיר על הצילום הזה: שני השדות לאישור העובד, בלי עד שמאשר.
const v18Dispute = [{ noteIndex: 0, rowIndex: 1, lineNumber: 2, code: '222', description: 'חלב בדיקה',
  fields: [{ field: 'quantity', selected: 6, other: 13, confirmed: 0 }, { field: 'lineTotalExVat', selected: 30, other: 65, confirmed: 0 }] }];
const strongReads = (selected, first, second, extra, stage = 'second_strong_read') => [{ stage: 'consensus_escalation', value: selected, selected: true },
  { stage: 'consensus_1', value: first }, { stage: 'consensus_2', value: second }, { stage, value: extra }];
async function health(extraEnv = {}) {
  const { server } = scanServer([], extraEnv);
  const req = Readable.from([]);
  req.method = 'GET'; req.url = '/health'; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { origin: 'https://asafkiri.github.io' };
  const response = fakeResponse();
  const ended = new Promise(resolve => { response.resolveEnd = resolve; });
  server.emit('request', req, response);
  await ended;
  server.close();
  return response.json();
}
// התשובה בלי הרשומה של הקריאה החזקה השנייה ובלי מה שמשתנה מריצה לריצה (מזהה וזמנים).
function comparable(output) {
  const copy = JSON.parse(JSON.stringify(output));
  if (copy.consensus) delete copy.consensus.secondStrongRead;
  if (copy.scanAudit) {
    for (const key of ['secondStrongRead', 'id', 'startedAt', 'completedAt']) delete copy.scanAudit[key];
    for (const attempt of copy.scanAudit.attempts) { delete attempt.startedAt; delete attempt.completedAt; }
  }
  return copy;
}

test('v19: a quantity Terra read and no cheap read confirms is accepted when a second strong read reads it the same', async () => {
  for (const extraBody of [{}, APP_142]) {
    const label = JSON.stringify(extraBody);
    const { output, calls, logs } = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(fourRowPaper)], input, {}, extraBody);
    assert.equal(calls.length, 4, label + ': the second strong read takes the checksum-retry slot');
    assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
      [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true], ['second_strong_read', false]], label);
    // C3: המודל החזק במאמץ גבוה, אותם צילומים ואותן הנחיות — ובהנחיה רק המקומות.
    assert.equal(calls[3].model, 'gpt-5.6-terra', label);
    assert.equal(calls[3].service_tier, 'priority', label);
    assert.equal(calls[3].reasoning.effort, 'high', label);
    assert.deepEqual(calls[3].input[0], calls[0].input[0], label);
    assert.deepEqual(calls[3].input[1].content.slice(0, -1), calls[0].input[1].content, label);
    const note = calls[3].input[1].content.at(-1).text;
    assert.ok(note.includes('מסמך noteIndex=0, עמוד 1, שורה 2: quantity, lineTotalExVat.'), note);
    assert.ok(note.includes('באופן עצמאי') && note.includes('עמודת הקוד נקראת בהסטה של שורה אחת') && note.includes('שווה למונה "פריטים" המודפס'), note);
    for (const value of ['13', '17', '65', '85', '30', '91', '222', '₪', 'code']) assert.ok(!note.includes(value), label + ' ' + value);
    // הערכים הם של הקריאה שנבחרה (Terra), והיא נשארת הקריאה שנבחרה.
    assert.equal(output.model, 'gpt-5.6-terra', label);
    assert.equal(output.requestId, 'test-3', label);
    assert.equal(output.consensus.escalationSelected, true, label);
    assert.equal(output.checksumRetryAttempted, false, label);
    assert.equal(output.scan.documents[0].rows[1].quantity, 6, label);
    assert.equal(output.paperValidation[0].receivable, true, label);
    // השדות נסגרו: אין מחלוקת ואין אישור ידני.
    assert.deepEqual(output.consensus.disputedRows, [], label);
    assert.ok(!output.scan.warnings.some(warning => warning.includes('אישור ידני')), label);
    // C4: כל שדה שנסגר — מסמך, שורה (עמוד ומספר מודפס), שדה, מה כל קריאה ראתה, והכלל.
    assert.deepEqual(output.consensus.secondStrongRead, { outcome: 'read', stage: 'second_strong_read', model: 'gpt-5.6-terra', requestId: 'test-4',
      asked: 2, usage: { input_tokens: 10, output_tokens: 20 }, open: [], closed: [
        { noteIndex: 0, rowIndex: 1, page: 1, lineNumber: 2, field: 'quantity', value: 6, reads: strongReads(6, 13, 17, 6), rule: 'second_strong_read' },
        { noteIndex: 0, rowIndex: 1, page: 1, lineNumber: 2, field: 'lineTotalExVat', value: 30, reads: strongReads(30, 65, 85, 30), rule: 'second_strong_read' }] }, label);
    assert.deepEqual(output.scanAudit.secondStrongRead, output.consensus.secondStrongRead, label);
    assert.deepEqual(output.scanAudit.attempts[3].usage, { input_tokens: 10, output_tokens: 20 }, label);
    assert.equal(logs.length, 1, label);
    assert.equal(logs[0][0], 'invoice_scan_audit', label);
    assert.deepEqual(logs[0][1].secondStrongRead, output.consensus.secondStrongRead, label);
    assert.ok(logs[0][1].attempts.some(a => a.stage === 'second_strong_read' && a.usage.output_tokens === 20), label);
  }
});

test('v19: a second strong read that reads a third value, misses the row or fails changes nothing, and never adds a dispute', async () => {
  const v18 = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper)], input, SECOND_OFF);
  assert.equal(v18.calls.length, 3);
  assert.deepEqual(v18.output.consensus.disputedRows, v18Dispute);
  const withoutRow = doc({ ...fourRowPaper, rows: fourRows().filter((item, index) => index !== 1) });
  for (const [strong2, outcome, error, reason, last] of [
    [answer(rowTwo({ quantity: 9, lineTotalExVat: 45 })), 'read', undefined, 'disagrees', [{ stage: 'second_strong_read', value: 9 }, { stage: 'second_strong_read', value: 45 }]],
    [answer(withoutRow), 'read', undefined, 'not_seen', [{ stage: 'second_strong_read', value: null, seen: false }, { stage: 'second_strong_read', value: null, seen: false }]],
    [new Error('test network failure'), 'failed', 'openai_network_error', 'failed', [{ stage: 'consensus_2', value: 17 }, { stage: 'consensus_2', value: 85 }]],
    [{ output_text: 'invalid json' }, 'failed', 'invalid_model_output', 'failed', [{ stage: 'consensus_2', value: 17 }, { stage: 'consensus_2', value: 85 }]]]) {
    const label = outcome + ' ' + reason + ' ' + error;
    const { output, calls } = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), strong2]);
    assert.equal(calls.length, 4, label + ': one call, never retried');
    assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
      [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true], ['second_strong_read', false]], label);
    const record = output.consensus.secondStrongRead;
    assert.equal(record.outcome, outcome, label);
    assert.equal(record.error, error, label);
    assert.deepEqual(record.closed, [], label);
    assert.deepEqual(record.open.map(item => [item.field, item.reason, item.value, item.reads.at(-1)]),
      [['quantity', reason, 6, last[0]], ['lineTotalExVat', reason, 30, last[1]]], label);
    // הקריאה שנבחרה, המחלוקת והאזהרה — בדיוק של שירות 18.
    assert.deepEqual(output.scan, v18.output.scan, label);
    const { secondStrongRead: unusedRecord, ...rest } = output.consensus;
    assert.deepEqual(rest, v18.output.consensus, label);
    assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')), label);
  }
  // היא רק מצביעה: קוד אחר שקראה בשורה שכל השאר מסכימים עליה אינו נעשה מחלוקת.
  const otherCode = doc({ ...fourRowPaper, docDate: '1.9.2026', rows: fourRows().map((item, index) => index === 0 ? row({ ...item, code: '119' }) : item) });
  const { output } = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(otherCode)]);
  assert.deepEqual(output.consensus.secondStrongRead.closed.map(item => item.field), ['quantity', 'lineTotalExVat']);
  assert.deepEqual(output.consensus.disputedRows, []);
  assert.deepEqual(output.consensus.docDateUnconfirmed, []);
  assert.deepEqual(output.consensus.missingRows, []);
});

test('v19 C1: a field is accepted only when the selected paper and the row itself close, within the existing rounding allowance', async () => {
  assert.equal(tnuvaRowArithmetic(row()), true);
  assert.equal(tnuvaRowArithmetic(row({ quantity: 4, unitPriceExVat: 15.66, lineTotalExVat: 62.63 })), true, 'the documented rounded-unit allowance');
  assert.equal(tnuvaRowArithmetic(row({ lineTotalExVat: 50.06 })), true);
  assert.equal(tnuvaRowArithmetic(row({ lineTotalExVat: 50.07 })), false);
  assert.equal(tnuvaRowArithmetic(row({ quantity: 10, unitPriceExVat: .305, lineTotalExVat: 3.06 })), true);
  assert.equal(tnuvaRowArithmetic(row({ quantity: 10, unitPriceExVat: .305, lineTotalExVat: 3.07 })), false);
  for (const field of ['quantity', 'unitPriceExVat', 'lineTotalExVat']) assert.equal(tnuvaRowArithmetic(row({ [field]: null })), null, field);
  // Terra לא קרא את מונה "פריטים": הנייר אינו מוכיח דבר, ואין קריאה נוספת בתשלום.
  const noCounter = item => doc({ ...item, itemsPrintedLines: null });
  const missing = await request([answer(noCounter(lunaThirteen)), answer(noCounter(lunaSeventeen)), answer(noCounter(fourRowPaper))]);
  assert.equal(missing.calls.length, 3);
  assert.equal(missing.output.paperValidation[0].missingSummary, true);
  assert.equal(missing.output.consensus.secondStrongRead.outcome, 'not_needed');
  assert.equal(missing.output.consensus.secondStrongRead.asked, 0);
  assert.deepEqual(missing.output.consensus.disputedRows.map(item => item.fields.map(field => field.field)), [['quantity', 'lineTotalExVat']]);
  // מחיר היחידה לא נקרא: הנייר נסגר, אבל החשבון של השורה עצמה אינו ניתן לבדיקה.
  const noUnit = item => doc({ ...item, rows: item.rows.map((each, index) => index === 1 ? { ...each, unitPriceExVat: null } : each) });
  const unitless = await request([answer(noUnit(lunaThirteen)), answer(noUnit(lunaSeventeen)), answer(noUnit(fourRowPaper))]);
  assert.equal(unitless.calls.length, 3);
  assert.equal(unitless.output.paperValidation[0].ok, true);
  assert.equal(unitless.output.consensus.secondStrongRead.asked, 0);
  assert.equal(unitless.output.consensus.disputedRows.length, 1);
  // מחיר יחידה מעוגל: 4 × 15.66 = 62.64 מול 62.63 המודפס — בתוך הסבילות הקיימת, ולכן נסגר.
  const rounded = paper(fourRows().map((item, index) => index === 1 ? row({ ...item, quantity: 4, unitPriceExVat: 15.66, lineTotalExVat: 62.63 }) : item));
  const roundedRow = changes => doc({ ...rounded, rows: rounded.rows.map((item, index) => index === 1 ? { ...item, ...changes } : item) });
  const allowed = await request([answer(roundedRow({ quantity: 5, lineTotalExVat: 78.3 })), answer(roundedRow({ quantity: 3, lineTotalExVat: 46.98 })), answer(rounded), answer(rounded)]);
  assert.equal(allowed.calls.length, 4);
  assert.deepEqual(allowed.output.consensus.secondStrongRead.closed.map(item => [item.field, item.value]), [['quantity', 4], ['lineTotalExVat', 62.63]]);
  assert.deepEqual(allowed.output.consensus.disputedRows, []);
  // Terra קרא מחיר יחידה שאינו מתיישב עם הכמות והסכום: הנייר אינו נסגר. קריאת ההצלה יוצאת
  // כמו בשירות 18, בלי מקומות בהנחיה, ואינה מצביעה — גם כשהיא קוראת בדיוק כמו Terra.
  const offUnit = rowTwo({ unitPriceExVat: 5.5 });
  const unclosed = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(offUnit), answer(offUnit)]);
  assert.equal(unclosed.calls.length, 4);
  assert.deepEqual(unclosed.output.scanAudit.attempts.map(a => [a.stage, a.selected]),
    [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true], ['checksum_retry', false]]);
  assert.ok(!unclosed.calls[3].input[1].content.at(-1).text.includes('בנוסף'));
  assert.equal(unclosed.output.consensus.secondStrongRead.outcome, 'not_needed');
  assert.deepEqual(unclosed.output.consensus.disputedRows.map(item => item.fields.map(field => field.field)), [['quantity', 'unitPriceExVat', 'lineTotalExVat']]);
});

test('v19 C2: only the quantity and money of an ordinary item row — never the code, the star, a deposit, returns, a credit note or a mixed paper', async () => {
  const open = (selected, ...others) => scanSecondStrongOpenFields(scan(selected), others.map(scan), input)
    .map(item => [item.rowIndex, item.page, item.lineNumber, item.field]);
  assert.deepEqual(open(fourRowPaper, lunaThirteen, lunaSeventeen), [[1, 1, 2, 'quantity'], [1, 1, 2, 'lineTotalExVat']]);
  // 2 מתוך 3 לא השתנה: קריאה זולה שמאשרת — אין מה לשאול.
  assert.deepEqual(open(fourRowPaper, fourRowPaper, lunaSeventeen), []);
  assert.deepEqual(open(fourRowPaper, rowTwo({ unitPriceExVat: 6 }), rowTwo({ unitPriceExVat: 7 })), [[1, 1, 2, 'unitPriceExVat']]);
  // קוד, כוכבית ועמוד אינם נשאלים, גם כשאף עד אינו מאשר אותם.
  assert.deepEqual(open(fourRowPaper, rowTwo({ code: '229', promoStar: true, sourcePage: 2 }), rowTwo({ code: '228', promoStar: true, sourcePage: 2 })), []);
  // שורה שרק הקריאה שנבחרה ראתה, ונייר שאינו נסגר.
  assert.deepEqual(open(fourRowPaper, droppedRowPaper, droppedRowPaper), []);
  assert.deepEqual(open(doc({ ...fourRowPaper, subtotalExVat: 92 }), lunaThirteen, lunaSeventeen), []);
  // פיקדון.
  const deposit = doc({ ...fourRowPaper, rows: fourRows().map((item, index) => index === 1 ? row({ ...item, description: 'פיקדון בקבוק' }) : item) });
  const depositRead = quantity => doc({ ...deposit, rows: deposit.rows.map((item, index) => index === 1 ? { ...item, quantity, lineTotalExVat: quantity * 5 } : item) });
  assert.deepEqual(open(deposit, depositRead(13), depositRead(17)), []);
  // זיכוי, זיכוי שזוהה רק לפי המינוס, ונייר מעורב — וגם שורת ההחזרות עצמה.
  const credit = item => doc({ ...item, docType: 'credit', subtotalExVat: -91, vatAmount: -16.38, totalInclVat: -107.38 });
  const minus = item => doc({ ...item, subtotalExVat: -91 });
  const mixed = item => doc({ ...item, subtotalExVat: 81, returnsSectionTotalExVat: 10, returnsPrintedLines: 1,
    rows: [...item.rows, row({ section: 'returns', lineNumber: 5, quantity: 2, lineTotalExVat: 10 })] });
  for (const kind of [credit, minus, mixed]) {
    assert.equal(tnuvaPaperCheck(kind(fourRowPaper), 1).ok, true, kind.name);
    assert.equal(tnuvaPaperCheck(kind(fourRowPaper), 1).receivable, false, kind.name);
    assert.deepEqual(open(kind(fourRowPaper), kind(lunaThirteen), kind(lunaSeventeen)), [], kind.name);
  }
  const returnsRead = quantity => doc({ ...mixed(fourRowPaper), rows: mixed(fourRowPaper).rows.map((item, index) => index === 4 ? { ...item, quantity, lineTotalExVat: quantity * 5 } : item) });
  assert.deepEqual(open(mixed(fourRowPaper), returnsRead(3), returnsRead(4)), []);
  // מקצה לקצה: הכמות והסכום נסגרים, והקוד והכוכבית שבמחלוקת נשארים בדיוק כפי שהיו —
  // אצל העובד ומול המאגר — גם כשהקריאה השנייה קוראת אותם כמו Terra. הקוד של Terra מאושר כאן
  // בקריאה זולה אחת: שורה שהזהות שלה פתוחה (confirmed 0) אינה נשאלת כלל — ראו את הבדיקה
  // "a row whose identity is still open".
  const { output, calls } = await request([answer(rowTwo({ promoStar: true, quantity: 13, lineTotalExVat: 65 })),
    answer(rowTwo({ code: '228', promoStar: true, quantity: 17, lineTotalExVat: 85 })), answer(fourRowPaper), answer(fourRowPaper)]);
  assert.equal(calls.length, 4);
  const note = calls[3].input[1].content.at(-1).text;
  assert.ok(note.includes('שורה 2: quantity, lineTotalExVat.') && !note.includes('code') && !note.includes('promoStar'), note);
  assert.deepEqual(output.consensus.secondStrongRead.closed.map(item => item.field), ['quantity', 'lineTotalExVat']);
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, item.fields]),
    [[1, [{ field: 'code', selected: '222', other: '228', confirmed: 1 }, { field: 'promoStar', selected: false, other: true, confirmed: 0 }]]]);
  assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')), 'the star still goes to the worker');
  // ונייר זיכוי: אין קריאה רביעית בתשלום.
  const creditRun = await request([answer(credit(lunaThirteen)), answer(credit(lunaSeventeen)), answer(credit(fourRowPaper))]);
  assert.equal(creditRun.calls.length, 3);
  assert.equal(creditRun.output.consensus.secondStrongRead.outcome, 'not_needed');
  assert.deepEqual(creditRun.output.consensus.disputedRows.map(item => item.fields.map(field => field.field)), [['quantity', 'lineTotalExVat']]);
});

// ===== v19, מהביקורת: מתי מותר בכלל לשאול את הקריאה החזקה השנייה =====
// שלב 3 של הבעלים ("Terra אינו מסכים עם אף אחת מהזולות") מניח שהזולות נחלקו על השדה.
// כששתיהן קראו אותו ערך, זה שלב 1: שתי קריאות שמסכימות ו-Terra שחולק עליהן — 2 מול 1,
// ושתי קריאות חזקות שחוזרות על אותה טעות הן 2 מול 2, לא הכרעה. השדה אצל העובד, כמו בשירות 18.
test('v19: two cheap reads that read a field alike are never outvoted by two strong reads — nor is one cheap read alone', async () => {
  // שני תאומים באותו מחיר בשורות סמוכות (10 ו-6 יחידות ב-3.47). שתי הקריאות הזולות קראו אותם
  // נכון וזהה, ונחלקו רק על הקוד של שורה 4 — זה מה שמסלים. Terra החליף בין הכמויות והסכומים
  // של שתי השורות: הנייר שלו עדיין נסגר (אותו סכום, אותו מונה), וגם החשבון של כל שורה.
  const twins = () => [row({ code: '111', lineNumber: 1 }),
    row({ code: '14761056', lineNumber: 2, quantity: 10, unitPriceExVat: 3.47, lineTotalExVat: 34.7 }),
    row({ code: '14761414', lineNumber: 3, quantity: 6, unitPriceExVat: 3.47, lineTotalExVat: 20.82 }),
    row({ code: '444', lineNumber: 4, quantity: 1, unitPriceExVat: 3, lineTotalExVat: 3 })];
  const printed = paper(twins());
  const otherCode = paper(twins().map((item, index) => index === 3 ? { ...item, code: '445' } : item));
  const swapped = paper(twins().map((item, index) => index === 1 ? { ...item, quantity: 6, lineTotalExVat: 20.82 }
    : index === 2 ? { ...item, quantity: 10, lineTotalExVat: 34.7 } : item));
  assert.equal(tnuvaPaperCheck(swapped, 1).receivable, true, 'the swapped read still closes against the paper');
  assert.deepEqual(scanSecondStrongOpenFields(scan(swapped), [scan(printed), scan(otherCode)], input), []);
  for (const extraBody of [{}, APP_142]) {
    const label = JSON.stringify(extraBody);
    const dark = await request([answer(printed), answer(otherCode), answer(swapped)], input, SECOND_OFF, extraBody);
    const lit = await request([answer(printed), answer(otherCode), answer(swapped), answer(swapped)], input, {}, extraBody);
    assert.equal(lit.calls.length, 3, label + ': nothing a second strong read may settle');
    assert.deepEqual(lit.calls, dark.calls, label);
    assert.deepEqual(comparable(lit.output), comparable(dark.output), label);
    assert.equal(lit.output.consensus.escalationSelected, true, label);
    assert.deepEqual([lit.output.consensus.secondStrongRead.outcome, lit.output.consensus.secondStrongRead.asked], ['not_needed', 0], label);
    assert.deepEqual(lit.output.consensus.disputedRows.map(item => [item.lineNumber, item.fields.map(field => [field.field, field.selected, field.other, field.confirmed])]), [
      [2, [['quantity', 6, 10, 0], ['lineTotalExVat', 20.82, 34.7, 0]]],
      [3, [['quantity', 10, 6, 0], ['lineTotalExVat', 34.7, 20.82, 0]]],
      [4, [['code', '444', '445', 1]]]], label);
    assert.ok(lit.output.scan.warnings.some(warning => warning.includes('אישור ידני')), label);
  }
  // הזולות נחלקו ביניהן על הכמות בשורה 2 (10 ו-9), אבל רק שם: השורה הזאת נשאלת, וזו שהזולות
  // הסכימו עליה (שורה 3) לא — לפי שדה ושורה, לא לפי תעודה.
  const nine = paper(twins().map((item, index) => index === 3 ? { ...item, code: '445' } : index === 1 ? { ...item, quantity: 9, lineTotalExVat: 31.23 } : item));
  assert.deepEqual(scanSecondStrongOpenFields(scan(swapped), [scan(printed), scan(nine)], input).map(item => [item.lineNumber, item.field]),
    [[2, 'quantity'], [2, 'lineTotalExVat']]);
  // קריאה זולה אחת שהושלמה (השנייה נפלה פעמיים) אינה "נחלקו": Terra ו-Terra#2 שקראו 6 מול ה-13
  // שלה אינם גוברים עליה. השדות אצל העובד, כמו בשירות 18, ואין קריאה רביעית בתשלום.
  const oneCheap = () => [answer(lunaThirteen), new Error('test network failure'), new Error('test network failure'), answer(fourRowPaper)];
  const loneOff = await request(oneCheap(), input, SECOND_OFF);
  const lone = await request([...oneCheap(), answer(fourRowPaper)]);
  assert.equal(lone.calls.length, 4);
  assert.equal(lone.output.consensus.reason, 'read_failed');
  assert.equal(lone.output.consensus.escalationSelected, true);
  assert.equal(lone.output.consensus.secondStrongRead.outcome, 'not_needed');
  assert.deepEqual(lone.output.consensus.disputedRows, loneOff.output.consensus.disputedRows);
  assert.deepEqual(lone.output.consensus.disputedRows.map(item => item.fields.map(field => [field.field, field.selected, field.other, field.confirmed])),
    [[['quantity', 6, 13, 0], ['lineTotalExVat', 30, 65, 0]]]);
});

test('v19 C2 on every read: a credit note, returns, a minus or a deposit that a cheap read saw is never closed by Terra twice', async () => {
  const open = (selected, ...others) => scanSecondStrongOpenFields(scan(selected), others.map(scan), input).map(item => item.field);
  assert.deepEqual(open(fourRowPaper, lunaThirteen, lunaSeventeen), ['quantity', 'lineTotalExVat']);
  // שתי הקריאות הזולות ראו זיכוי (כותרת ומינוס), ו-Terra קרא חשבונית רגילה שנסגרת.
  const credit = item => doc({ ...item, docType: 'credit', subtotalExVat: -91, vatAmount: -16.38, totalInclVat: -107.38 });
  assert.deepEqual(open(fourRowPaper, credit(lunaThirteen), credit(lunaSeventeen)), []);
  // מספיקה קריאה אחת: זיכוי, מינוס בלבד, שורת החזרות, או שורה שהיא קראה כפיקדון.
  const minus = item => doc({ ...item, subtotalExVat: -91 });
  const withReturns = item => doc({ ...item, rows: [...item.rows, row({ section: 'returns', lineNumber: 5, quantity: 2, lineTotalExVat: 10 })] });
  const asDeposit = item => doc({ ...item, rows: item.rows.map((each, index) => index === 1 ? { ...each, description: 'פיקדון בקבוק' } : each) });
  for (const kind of [credit, minus, withReturns, asDeposit]) {
    assert.deepEqual(open(fourRowPaper, kind(lunaThirteen), lunaSeventeen), [], kind.name);
    assert.deepEqual(open(fourRowPaper, lunaThirteen, kind(lunaSeventeen)), [], kind.name);
  }
  // מקצה לקצה: הזולות ראו זיכוי. אין קריאה רביעית, והשורה אצל העובד כמו בשירות 18.
  const responses = () => [answer(credit(lunaThirteen)), answer(credit(lunaSeventeen)), answer(fourRowPaper)];
  const dark = await request(responses(), input, SECOND_OFF);
  const lit = await request([...responses(), answer(fourRowPaper)]);
  assert.equal(lit.calls.length, 3);
  assert.deepEqual(comparable(lit.output), comparable(dark.output));
  assert.equal(lit.output.consensus.secondStrongRead.outcome, 'not_needed');
  assert.deepEqual(lit.output.consensus.disputedRows.map(item => item.fields.map(field => field.field)), [['quantity', 'lineTotalExVat']]);
});

test('v19: a row whose identity is still open keeps its quantity and money with the worker — the second strong read never settles a code, not even indirectly', async () => {
  // שורה 2: שתי הקריאות הזולות קראו קוד 222 (13 ו-17 יחידות), ו-Terra קרא את התאום 229 עם 6.
  // אף קריאה אינה מאשרת את הקוד של Terra (confirmed 0). אילו הכמות והסכום היו נסגרים כאן,
  // הכרטיס היה נשאר עם הקוד בלבד — ואצל הלקוח כלל שתי הזהויות באותו מחיר סוגר כרטיס כזה
  // לפי המודל החזק. כך הקריאה הרביעית הייתה מכריעה זהות, גם כשהיא עצמה קראה 222.
  const twin = rowTwo({ code: '229' });
  const dark = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(twin)], input, SECOND_OFF, APP_142);
  const lit = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(twin), answer(fourRowPaper)], input, {}, APP_142);
  assert.deepEqual(scanSecondStrongOpenFields(scan(twin), [scan(lunaThirteen), scan(lunaSeventeen)], input), []);
  assert.equal(lit.calls.length, 3);
  assert.deepEqual(lit.calls, dark.calls);
  assert.deepEqual(comparable(lit.output), comparable(dark.output));
  assert.equal(lit.output.consensus.secondStrongRead.outcome, 'not_needed');
  assert.deepEqual(lit.output.consensus.disputedRows.map(item => item.fields.map(field => [field.field, field.selected, field.other, field.confirmed])),
    [[['code', '229', '222', 0], ['quantity', 6, 13, 0], ['lineTotalExVat', 30, 65, 0]]]);
  // הקוד של Terra מאושר בקריאה זולה אחת (2 מתוך 3, שלב 2): הזהות סגורה, ולכן הכמות והסכום
  // שהזולות נחלקו עליהם ו-Terra לא הסכים עם אף אחת — נשאלים, ונסגרים כשהקריאה השנייה קוראת כמו
  // Terra. הקוד נשאר ברשימה עם confirmed 1, בדיוק כמו בשירות 18.
  const settled = await request([answer(lunaThirteen), answer(rowTwo({ code: '229', quantity: 17, lineTotalExVat: 85 })),
    answer(fourRowPaper), answer(fourRowPaper)]);
  assert.equal(settled.calls.length, 4);
  assert.deepEqual(settled.output.consensus.secondStrongRead.closed.map(item => [item.lineNumber, item.field, item.value]),
    [[2, 'quantity', 6], [2, 'lineTotalExVat', 30]]);
  assert.deepEqual(settled.output.consensus.disputedRows.map(item => item.fields), [[{ field: 'code', selected: '222', other: '229', confirmed: 1 }]]);
});

test('v19 C4: the invoice_scan_audit line that console prints on Cloud Run carries every closed field in full', async () => {
  // start() יוצר את השרת בלי logger, ולכן היומן הוא console. console.info מציג אובייקט רק עד
  // עומק 2, ושם closed ו-open הופיעו כ-[Object]. כאן היומן הוא Console אמיתי שכותב לזרם.
  const printedLog = async (responses, extraEnv = {}) => {
    let text = '';
    const stream = new Writable({ write(chunk, encoding, done) { text += chunk; done(); } });
    const { server, calls } = scanServer(responses, extraEnv, new Console({ stdout: stream, stderr: stream }));
    const output = await sendScan(server, { documents: input, catalog }).ended;
    server.close();
    return { output, calls, text };
  };
  const { output, calls, text } = await printedLog([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(fourRowPaper)]);
  assert.equal(calls.length, 4);
  assert.ok(text.startsWith('invoice_scan_audit {'), text);
  assert.equal(text.match(/invoice_scan_audit/g).length, 1, 'one log call');
  const lines = text.split('\n').filter(line => line.includes('secondStrongRead'));
  assert.equal(lines.length, 1, text);
  assert.ok(!lines[0].includes('[Object]'), lines[0]);
  // שורה אחת של JSON מלא: מזהה הסריקה, ולכל שדה שנסגר — מסמך, עמוד, שורה מודפסת, שדה, מה
  // כל קריאה ראתה, והכלל; וגם המודל, מזהה הבקשה והטוקנים של הקריאה הנוספת.
  const logged = JSON.parse(lines[0].trim().replace(/^secondStrongRead: /, '').replace(/,$/, ''));
  assert.deepEqual(logged, { scanAuditId: output.scanAudit.id, ...output.consensus.secondStrongRead });
  assert.deepEqual(logged.closed.map(item => [item.noteIndex, item.page, item.lineNumber, item.field, item.reads.map(read => read.stage + '=' + read.value).join(' '), item.rule]), [
    [0, 1, 2, 'quantity', 'consensus_escalation=6 consensus_1=13 consensus_2=17 second_strong_read=6', 'second_strong_read'],
    [0, 1, 2, 'lineTotalExVat', 'consensus_escalation=30 consensus_1=65 consensus_2=85 second_strong_read=30', 'second_strong_read']]);
  assert.deepEqual([logged.model, logged.requestId, logged.usage], ['gpt-5.6-terra', 'test-4', { input_tokens: 10, output_tokens: 20 }]);
  // התשובה עצמה אינה משתנה: אותה רשומה, בלי מזהה הסריקה, בקונצנזוס וביומן הסריקה.
  assert.ok(!('scanAuditId' in output.consensus.secondStrongRead));
  assert.deepEqual(output.scanAudit.secondStrongRead, output.consensus.secondStrongRead);
  // שדה שנשאר לעובד נרשם באותה צורה, עם הסיבה.
  const left = await printedLog([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(rowTwo({ quantity: 9, lineTotalExVat: 45 }))]);
  const leftLine = left.text.split('\n').find(line => line.includes('secondStrongRead'));
  assert.deepEqual(JSON.parse(leftLine.trim().replace(/^secondStrongRead: /, '').replace(/,$/, '')).open.map(item => [item.lineNumber, item.field, item.reason, item.reads.at(-1).value]),
    [[2, 'quantity', 'disagrees', 9], [2, 'lineTotalExVat', 'disagrees', 45]]);
  // המתג כבוי: אין רשומה, וגם לא ביומן.
  const off = await printedLog([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper)], SECOND_OFF);
  assert.ok(off.text.startsWith('invoice_scan_audit {'), off.text);
  assert.ok(!off.text.includes('secondStrongRead') && !off.text.includes('second_strong_read'), off.text);
});

test('v19: the second strong read seconds Terra only — when the paper selected a cheap read, Terra already disagreed and nothing is bought', async () => {
  // הקריאה הזולה הראשונה נסגרת מול הנייר ונבחרת; Terra קרא 17. שתי קריאות חזקות שאינן
  // מסכימות זו עם זו אינן מאשרות דבר, ולכן אין קריאה רביעית.
  const { output, calls } = await request([answer(fourRowPaper), answer(lunaThirteen), answer(lunaSeventeen)], input, {}, APP_142);
  assert.equal(calls.length, 3);
  assert.equal(output.consensus.escalationSelected, false);
  assert.equal(output.model, 'gpt-5.6-luna');
  assert.equal(output.consensus.secondStrongRead.outcome, 'not_needed');
  assert.deepEqual(output.consensus.disputedRows.map(item => item.fields),
    [[{ field: 'quantity', selected: 6, other: 13, confirmed: 0 }, { field: 'lineTotalExVat', selected: 30, other: 65, confirmed: 0 }]]);
  // וההצבעה עצמה: רק ערך זהה לערך שנבחר סוגר, והערך תמיד של הקריאה שנבחרה.
  const places = scanSecondStrongOpenFields(scan(fourRowPaper), [scan(lunaThirteen), scan(lunaSeventeen)], input);
  const votes = extra => scanSecondStrongReadVotes({ stage: 'consensus_escalation', scan: scan(fourRowPaper) },
    [{ stage: 'consensus_1', scan: scan(lunaThirteen) }, { stage: 'consensus_2', scan: scan(lunaSeventeen) }], extra, places);
  assert.deepEqual(votes({ stage: 'second_strong_read', scan: scan(lunaSeventeen) }).closed, []);
  assert.deepEqual(votes({ stage: 'second_strong_read', scan: scan(rowTwo({ quantity: 6, lineTotalExVat: 31 })) }).closed.map(item => [item.field, item.value]), [['quantity', 6]]);
  assert.deepEqual(votes(null).open.map(item => item.reason), ['failed', 'failed']);
});

// ===== v19, מהביקורת: הקריאה השנייה מצביעה רק על השורה המודפסת שנשאלה =====
// הקול של הקריאה השנייה נלקח מהשורה שלה שמיושרת מול השורה של Terra — לפי מיקום כשמספר
// השורות שווה, ולפי תוכן כשאינו שווה. קריאה שנייה שדילגה על השורה שנשאלה מיושרת כך מול
// שורה שכנה באותו מחיר, וקראה בה בדיוק את מה ש-Terra שם בשורה שנשאלה — כש-Terra החליף
// בין שני תאומים. היא מעולם לא ראתה את השורה, והשדה נשאר לעובד.
test('v19: the second strong read votes only on the printed row it was asked about — a neighbouring same-price row it read instead confirms nothing', async () => {
  // הנייר: ארבע שורות, 98.11 ₪. בשורות 2 ו-3 שני תאומים ב-3.47: 7 יחידות (24.29) ו-6 (20.82).
  const twins = (codes = ['14761056', '14761414']) => [row({ code: '111', lineNumber: 1 }),
    row({ code: codes[0], lineNumber: 2, quantity: 7, unitPriceExVat: 3.47, lineTotalExVat: 24.29 }),
    row({ code: codes[1], lineNumber: 3, quantity: 6, unitPriceExVat: 3.47, lineTotalExVat: 20.82 }),
    row({ code: '444', lineNumber: 4, quantity: 1, unitPriceExVat: 3, lineTotalExVat: 3 })];
  const printed = paper(twins());
  const read = (rows, codes) => doc({ ...printed, rows: rows(twins(codes)) });
  // הזולות נחלקו על שורה 2 (8 ו-9) וקראו את שורה 3 נכון. Terra החליף בין התאומים: הנייר שלו
  // והחשבון של כל שורה עדיין נסגרים, והקוד של כל שורה מאושר בשתי הזולות.
  const cheap = (quantity, codes) => read(rows => rows.map((item, index) => index === 1 ? { ...item, quantity, lineTotalExVat: Math.round(quantity * 347) / 100 } : item), codes);
  const swapped = codes => read(rows => rows.map((item, index) => index === 1 ? { ...item, quantity: 6, lineTotalExVat: 20.82 }
    : index === 2 ? { ...item, quantity: 7, lineTotalExVat: 24.29 } : item), codes);
  assert.equal(tnuvaPaperCheck(swapped(), 1).receivable, true);
  // הקריאה השנייה דילגה על שורה 2: שלוש שורות (יישור לפי תוכן), או ארבע כששורה 4 נקראה
  // פעמיים (יישור לפי מיקום). בשני המקרים שורה 2 של Terra מיושרת מול שורה 3 המודפסת.
  const skipped = codes => read(rows => rows.filter((item, index) => index !== 1), codes);
  const skippedTwiceFour = read(rows => [rows[0], rows[2], rows[3], { ...rows[3], lineNumber: 5 }]);
  for (const [extra, label] of [[skipped(), 'three rows'], [skippedTwiceFour, 'four rows']]) {
    assert.ok(!extra.rows.some(item => item.code === '14761056'), label);
    assert.equal(tnuvaPaperCheck(extra, 1).ok, false, label);
    const responses = () => [answer(cheap(8)), answer(cheap(9)), answer(swapped())];
    const dark = await request(responses(), input, SECOND_OFF, APP_142);
    const lit = await request([...responses(), answer(extra)], input, {}, APP_142);
    assert.equal(lit.calls.length, 4, label);
    assert.equal(lit.output.consensus.escalationSelected, true, label);
    // שירות 18: שורה 2 (6 מול 8) ושורה 3 (7 מול 6) אצל העובד. כך גם כאן.
    assert.deepEqual(dark.output.consensus.disputedRows.map(item => item.lineNumber), [2, 3], label);
    assert.deepEqual(lit.output.consensus.disputedRows, dark.output.consensus.disputedRows, label);
    assert.deepEqual(lit.output.scan, dark.output.scan, label);
    const record = lit.output.consensus.secondStrongRead;
    assert.deepEqual(record.closed, [], label);
    // C4: הרשומה אינה מייחסת לקריאה השנייה ערך שלא קראה בשורה 2.
    assert.deepEqual(record.open.map(item => [item.lineNumber, item.field, item.reason, item.reads.at(-1)]), [
      [2, 'quantity', 'not_seen', { stage: 'second_strong_read', value: null, seen: false }],
      [2, 'lineTotalExVat', 'not_seen', { stage: 'second_strong_read', value: null, seen: false }]], label);
  }
  // אותו קוד בשתי השורות: הקוד אינו אומר איזו שורה מודפסת הקריאה השנייה קראה, ולכן הוא אינו
  // מזהה את השורה — לא נספר, גם כשהשורה המיושרת נושאת אותו קוד.
  const same = ['222', '222'];
  const places = scanSecondStrongOpenFields(scan(swapped(same)), [scan(cheap(8, same)), scan(cheap(9, same))], input);
  assert.deepEqual(places.map(item => [item.lineNumber, item.field]), [[2, 'quantity'], [2, 'lineTotalExVat']]);
  const votes = extra => scanSecondStrongReadVotes({ stage: 'consensus_escalation', scan: scan(swapped(same)) },
    [{ stage: 'consensus_1', scan: scan(cheap(8, same)) }, { stage: 'consensus_2', scan: scan(cheap(9, same)) }],
    { stage: 'second_strong_read', scan: scan(extra) }, places);
  assert.deepEqual(votes(skipped(same)).closed, []);
  assert.deepEqual(votes(skipped(same)).open.map(item => item.reason), ['not_seen', 'not_seen']);
  // הקריאה השנייה קראה בשורה 2 קוד אחר מזה של Terra: זו לא אותה שורה בעיניה, והקול אינו נספר.
  const fourVotes = extra => scanSecondStrongReadVotes({ stage: 'consensus_escalation', scan: scan(fourRowPaper) },
    [{ stage: 'consensus_1', scan: scan(lunaThirteen) }, { stage: 'consensus_2', scan: scan(lunaSeventeen) }],
    { stage: 'second_strong_read', scan: scan(extra) },
    scanSecondStrongOpenFields(scan(fourRowPaper), [scan(lunaThirteen), scan(lunaSeventeen)], input));
  assert.deepEqual(fourVotes(rowTwo({ code: '229' })).open.map(item => [item.field, item.reason, item.reads.at(-1)]), [
    ['quantity', 'not_seen', { stage: 'second_strong_read', value: null, seen: false }],
    ['lineTotalExVat', 'not_seen', { stage: 'second_strong_read', value: null, seen: false }]]);
  // ושורה אחרת שהקריאה השנייה פספסה אינה משנה דבר: השורה שנשאלה קראה אותה, באותו קוד, והיא נסגרת.
  assert.deepEqual(fourVotes(droppedRowPaper).closed.map(item => [item.lineNumber, item.field, item.reads.at(-1)]), [
    [2, 'quantity', { stage: 'second_strong_read', value: 6 }], [2, 'lineTotalExVat', { stage: 'second_strong_read', value: 30 }]]);
  const missedOther = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(droppedRowPaper)]);
  assert.deepEqual(missedOther.output.consensus.secondStrongRead.closed.map(item => item.field), ['quantity', 'lineTotalExVat']);
  assert.deepEqual(missedOther.output.consensus.disputedRows, []);
});

test('v19 (a): the checksum retry shares the slot — its note adds the open places without values, and it votes even when it loses', async () => {
  // שתי תעודות: בראשונה הקריאות נחלקו על שורה 2 ו-Terra נסגר; בשנייה "סהכ חייב מעמ"
  // נקרא 49 בכל הקריאות, ולכן קריאת ההצלה יוצאת — והמשבצת שלה היא גם הקריאה השנייה.
  const twoDocs = [{ ...input[0] }, { ...input[0], noteIndex: 1 }];
  const pair = (first, second) => ({ output_text: JSON.stringify({ documents: [first, second], warnings: [] }) });
  const short = doc({ noteIndex: 1, subtotalExVat: 49 });
  const responses = retry => [pair(lunaThirteen, short), pair(lunaSeventeen, short), pair(fourRowPaper, short), retry];
  const off = await request(responses(pair(fourRowPaper, short)), twoDocs, SECOND_OFF);
  const on = await request(responses(pair(fourRowPaper, short)), twoDocs);
  for (const run of [off, on]) {
    assert.equal(run.calls.length, 4, 'still four calls at most');
    assert.deepEqual(run.output.scanAudit.attempts.map(a => [a.stage, a.selected]),
      [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true], ['checksum_retry', false]]);
    assert.equal(run.output.checksumRetryAttempted, true);
    assert.equal(run.output.paperValidation[1].ok, false);
    assert.ok(run.output.scan.warnings.some(warning => warning.includes('גם אחרי קריאה חוזרת')));
  }
  // אותן בקשות, וההנחיה של קריאת ההצלה היא של שירות 18 ועוד המקומות בלבד.
  assert.deepEqual(on.calls.slice(0, 3), off.calls.slice(0, 3));
  const offNote = off.calls[3].input[1].content.at(-1).text, onNote = on.calls[3].input[1].content.at(-1).text;
  assert.ok(offNote.startsWith('אזהרת סכום ביקורת') && !offNote.includes('בנוסף'), offNote);
  assert.ok(onNote.startsWith(offNote), onNote);
  const added = onNote.slice(offNote.length);
  assert.ok(added.includes('מסמך noteIndex=0, עמוד 1, שורה 2: quantity, lineTotalExVat.'), added);
  for (const value of ['13', '17', '65', '85', '30', '91', '₪', 'noteIndex=1']) assert.ok(!added.includes(value), value);
  // שירות 18: קריאת הצלה שהפסידה אינה עדה. שירות 19: היא מצביעה, והשדות של התעודה הראשונה נסגרים.
  assert.deepEqual(off.output.consensus.disputedRows, v18Dispute);
  assert.deepEqual(on.output.consensus.disputedRows, []);
  const record = on.output.consensus.secondStrongRead;
  assert.deepEqual([record.stage, record.outcome, record.asked, record.requestId], ['checksum_retry', 'read', 2, 'test-4']);
  assert.deepEqual(record.closed.map(item => [item.noteIndex, item.lineNumber, item.field, item.rule, item.reads]), [
    [0, 2, 'quantity', 'second_strong_read', strongReads(6, 13, 17, 6, 'checksum_retry')],
    [0, 2, 'lineTotalExVat', 'second_strong_read', strongReads(30, 65, 85, 30, 'checksum_retry')]]);
  // קריאת הצלה שניצחה היא הקריאה שנבחרה, ולכן אינה מצביעה על עצמה: המחלוקת נמדדת
  // מול העדים כמו בשירות 18, ו-Terra הוא שמאשר את השורה.
  const won = await request(responses(pair(fourRowPaper, doc({ noteIndex: 1 }))), twoDocs);
  assert.equal(won.calls.length, 4);
  assert.deepEqual(won.output.scanAudit.attempts.map(a => a.selected), [false, false, false, true]);
  assert.equal(won.output.consensus.escalationSelected, false);
  assert.equal(won.output.consensus.secondStrongRead.outcome, 'selected');
  assert.deepEqual(won.output.consensus.secondStrongRead.closed, []);
  assert.deepEqual(won.output.consensus.disputedRows, []);
});

test('v19 C5: SECOND_STRONG_READ=off is service 18 — the same requests and the same answer — and /health says which', async () => {
  for (const value of ['off', 'OFF', ' off ', 'false', '0']) {
    const { output, calls, logs } = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper)], input, { SECOND_STRONG_READ: value });
    assert.equal(calls.length, 3, value);
    assert.ok(!('secondStrongRead' in output.consensus), value);
    assert.ok(!('secondStrongRead' in output.scanAudit), value);
    assert.ok(!('secondStrongRead' in logs[0][1]), value);
    assert.deepEqual(output.consensus.disputedRows, v18Dispute, value);
    assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')), value);
  }
  const on = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(fourRowPaper)]);
  const off = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper)], input, SECOND_OFF);
  assert.deepEqual(on.calls.slice(0, 3), off.calls, 'the extra read is added after the same three requests');
  // כשאין שדה פתוח שהיא רשאית לסגור, דלוק וכבוי הם אותן בקשות ואותה תשובה, שדה בשדה.
  const scenarios = [
    [agreed(doc()), {}],
    [[answer(shiftedCodes), answer(shiftedCodesOther), answer(shiftedCodes)], {}],
    [[answer(shiftedCodes), answer(shiftedCodesOther), answer(doc({ ...shiftedCodes, subtotalExVat: 79 }))], APP_142],
    [[...agreed(doc({ subtotalExVat: 49 })), answer(doc({ rows: [row({ code: '9' })] }))], {}],
    [[answer(fourRowPaper), answer(splitRowPaper), answer(fourRowPaper)], {}],
    [[answer(fourRowPaper), answer(lunaThirteen), answer(lunaSeventeen)], APP_142],
    [[answer(lunaThirteen), answer(lunaSeventeen), answer(rowTwo({ unitPriceExVat: 5.5 })), answer(rowTwo({ unitPriceExVat: 5.5 }))], {}],
    [[answer(doc()), new Error('test network failure'), new Error('test network failure'), new Error('test network failure')], {}]];
  for (const [responses, extraBody] of scenarios) {
    const dark = await request([...responses], input, SECOND_OFF, extraBody);
    const lit = await request([...responses], input, {}, extraBody);
    const label = JSON.stringify(lit.output.scanAudit.attempts.map(a => a.stage));
    assert.deepEqual(lit.calls, dark.calls, label);
    assert.deepEqual(comparable(lit.output), comparable(dark.output), label);
    assert.equal(lit.output.consensus.secondStrongRead.outcome, 'not_needed', label);
  }
  // /health: דלוק כברירת מחדל; כבוי במתג, וכבוי כשאין מודל הסלמה שאפשר לקרוא בו.
  for (const [extraEnv, expected] of [[{}, true], [SECOND_OFF, false], [{ OPENAI_RETRY_MODEL: '' }, false]]) {
    const status = await health(extraEnv);
    assert.equal(status.serviceVersion, 19, JSON.stringify(extraEnv));
    assert.equal(status.secondStrongRead, expected, JSON.stringify(extraEnv));
  }
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
  assert.deepEqual(output.consensus.docDateUnconfirmed, []);
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
// v18: הדגל שייך לסריקה, לא לחיבור. איסוף שולח רק מפתח ו-resume, ובקשה כפולה
// נצמדת לעבודה שכבר רצה — שתיהן מקבלות את הבחירה שהעבודה עשתה לפי הבקשה שפתחה אותה.
test('v18: the selection rule is fixed when the scan starts, so a resume or a duplicate send gets the same answer', async () => {
  const strongWorse = doc({ ...shiftedCodes, subtotalExVat: 79 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { server, calls } = scanServer([async () => { await gate; return answer(shiftedCodes); }, answer(shiftedCodesOther), answer(strongWorse)]);
  const until = async condition => { while (!condition()) await new Promise(resolve => setImmediate(resolve)); };
  // המודל אינו עונה עד שכל החיבורים נצמדו לעבודה, כדי שאף אחד מהם לא יפתח עבודה משלו.
  const first = sendScan(server, { documents: input, catalog, scanKey: key, strongReadSelection: true }, { drain: false, settled: true });
  await until(() => first.response.headersSent && calls.length === 2);
  const duplicate = sendScan(server, { documents: input, catalog, scanKey: key }, { settled: true });
  await until(() => duplicate.response.headersSent);
  first.response.drop(); // הטלפון איבד את הקו בזמן שהמודל עוד קורא
  const resume = sendScan(server, { scanKey: key, resume: true }, { settled: true });
  await until(() => resume.response.headersSent);
  release();
  const [resumed, joined] = await Promise.all([resume.ended, duplicate.ended]);
  assert.equal(calls.length, 3, 'one scan: two cheap reads and one escalation, paid once');
  assert.equal(resumed.ok, true);
  assert.equal(resumed.consensus.strongReadSelection, true);
  assert.equal(resumed.consensus.escalated, true);
  assert.equal(resumed.consensus.escalationSelected, false, 'the cheap read that closes the paper was selected');
  assert.equal(resumed.scan.documents[0].subtotalExVat, 80);
  assert.deepEqual(joined, resumed);
  server.close();
});
test('/health reports service 19 and that it honours strongReadSelection', async () => {
  const { server } = scanServer([]);
  const req = Readable.from([]);
  req.method = 'GET'; req.url = '/health'; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { origin: 'https://asafkiri.github.io' };
  const response = fakeResponse();
  const ended = new Promise(resolve => { response.resolveEnd = resolve; });
  server.emit('request', req, response);
  await ended;
  const health = response.json();
  assert.equal(health.serviceVersion, 19);
  assert.equal(health.strongReadSelection, true);
  assert.equal(health.resumableScans, true);
  assert.equal(health.photoFirst, true);
  assert.equal(health.scanAuditVersion, 1);
  assert.equal(health.keyStatus, 'ready');
  assert.equal(health.retryModel, 'gpt-5.6-terra');
  server.close();
});
test('a key the instance never saw says so, so the client knows to send the photos again', async () => {
  const { server, calls } = scanServer([]);
  const output = await sendScan(server, { scanKey: 'no-such-key-01', resume: true }).ended;
  assert.equal(output.ok, false);
  assert.equal(output.error, 'resume_unknown');
  assert.equal(output.serviceVersion, 19);
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
