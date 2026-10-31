import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Console } from 'node:console';
import { Readable, Writable } from 'node:stream';
import { tnuvaPaperCheck, scanChecksumMismatches, scanConsensusDiff, scanConsensusDisputedRows, scanConsensusMissingRows, scanConsensusDocDateUnconfirmed, alignConsensusRows, OPENAI_NETWORK_RETRY_WINDOW_MS, scanJobKey, scanJobId, createServer,
  tnuvaRowArithmetic, scanSecondStrongOpenFields, scanSecondStrongPlan,
  scanSecondStrongWholeReadDifferences, scanSecondStrongReadClosures,
  scanCodeReads, scanCodeAgreement, scanCodeAgreementPlan, scanCodeDisputes } from './server.js';

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
// v20: שדה קוד נושא גם reads ו-agreement; בדיקות של שירות 18 ו-19 משוות את השדות בלעדיהם.
const bare = fields => fields.map(({ reads: unusedReads, agreement: unusedAgreement, ...rest }) => rest);
const bareRows = rows => rows.map(entry => ({ ...entry, fields: bare(entry.fields) }));
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
  assert.equal(output.serviceVersion, 20);
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
    .map(item => [item.rowIndex, bare(item.fields)]), [[2, [{ field: 'code', selected: '333', other: null, confirmed: 0 }]]]);
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
  assert.deepEqual(scanConsensusDisputedRows(agree, [qtyDiffer, qtyDifferAgain]).map(item => [item.rowIndex, bare(item.fields)]),
    [[1, [{ field: 'quantity', selected: 6, other: 7, confirmed: 0 }, { field: 'lineTotalExVat', selected: 30, other: 35, confirmed: 0 }]]]);
  // מול קריאה אחת בלבד אין דעה שלישית, וכל הבדל נשאר מחלוקת.
  assert.deepEqual(scanConsensusDisputedRows(agree, [qtyDiffer]).map(item => item.rowIndex), [1]);
  // קוד נמסר תמיד, עם מספר הקריאות שמאשרות את הקוד שנבחר: הלקוח מכריע קוד
  // מול המאגר והמחיר, וזקוק לקוד היריב גם כשקריאה נוספת מסכימה עם הנבחר.
  const differ = withRow1({ code: '221' }), differAgain = withRow1({ code: '212' }), unread = withRow1({ code: null });
  assert.deepEqual(scanConsensusDisputedRows(agree, [agree, differ]).map(item => [item.rowIndex, bare(item.fields)]),
    [[1, [{ field: 'code', selected: '222', other: '221', confirmed: 1 }]]]);
  assert.deepEqual(scanConsensusDisputedRows(agree, [differ, differAgain]).map(item => [item.rowIndex, bare(item.fields)]),
    [[1, [{ field: 'code', selected: '222', other: '221', confirmed: 0 }]]]);
  // קריאה שלא הצליחה לקרוא את הקוד אינה היריב שמוצג: הקוד שנקרא בפועל הוא.
  assert.deepEqual(scanConsensusDisputedRows(agree, [unread, differ])[0].fields, [{ field: 'code', selected: '222', other: '221', confirmed: 0 }]);
  assert.deepEqual(scanConsensusDisputedRows(agree, [unread])[0].fields, [{ field: 'code', selected: '222', other: null, confirmed: 0 }]);
  // קריאה שלא ראתה את השורה אינה מאשרת אותה, אבל גם אינה חולקת על שדותיה.
  const droppedSecond = scan(doc({ ...fourRowPaper, rows: [fourRows()[0], fourRows()[2], fourRows()[3]] }));
  assert.deepEqual(scanConsensusDisputedRows(agree, [droppedSecond, agree]), []);
  assert.deepEqual(scanConsensusDisputedRows(agree, [droppedSecond, differ]).map(item => [item.rowIndex, bare(item.fields)]),
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
  assert.deepEqual(bare(output.consensus.disputedRows[0].fields), [{ field: 'code', selected: '333', other: '222', confirmed: 0 }]);
  assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')));
});

test('a code one cheap read confirms is reported for the catalog to settle, not for the user', async () => {
  const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(shiftedCodes)]);
  assert.equal(calls.length, 3);
  assert.equal(output.consensus.escalated, true);
  assert.equal(output.scan.documents[0].rows[1].code, '222');
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, bare(item.fields)]),
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
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, bare(item.fields)]),
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
  assert.deepEqual(second.output.consensus.disputedRows.map(item => [item.rowIndex, bare(item.fields)]),
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
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, bare(item.fields)]),
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
  assert.deepEqual(anchored.output.consensus.disputedRows.map(item => bare(item.fields)), [[{ field: 'code', selected: '222', other: '111', confirmed: 1 }]]);
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
    assert.deepEqual(output.consensus.disputedRows.map(item => bare(item.fields)),
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
  assert.deepEqual(output.consensus.disputedRows.map(item => bare(item.fields)),
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
    // C4: כל שדה שנסגר — מסמך, שורה (עמוד ומספר מודפס), שדה, מה כל קריאה ראתה, ומי סגר אותו.
    // הכרעת הבעלים הסופית: Terra#2 קראה את כל התעודה בדיוק כמו Terra (outcome identical, אין differences).
    assert.deepEqual(output.consensus.secondStrongRead, { outcome: 'identical', stage: 'second_strong_read', model: 'gpt-5.6-terra', requestId: 'test-4',
      asked: 2, usage: { input_tokens: 10, output_tokens: 20 }, open: [], notAsked: [], differences: [], closed: [
        { noteIndex: 0, rowIndex: 1, page: 1, lineNumber: 2, field: 'quantity', value: 6, reads: strongReads(6, 13, 17, 6), closedBy: 'second_strong_read' },
        { noteIndex: 0, rowIndex: 1, page: 1, lineNumber: 2, field: 'lineTotalExVat', value: 30, reads: strongReads(30, 65, 85, 30), closedBy: 'second_strong_read' }] }, label);
    assert.deepEqual(output.scanAudit.secondStrongRead, output.consensus.secondStrongRead, label);
    assert.deepEqual(output.scanAudit.attempts[3].usage, { input_tokens: 10, output_tokens: 20 }, label);
    assert.equal(logs.length, 1, label);
    assert.equal(logs[0][0], 'invoice_scan_audit', label);
    assert.deepEqual(logs[0][1].secondStrongRead, output.consensus.secondStrongRead, label);
    assert.ok(logs[0][1].attempts.some(a => a.stage === 'second_strong_read' && a.usage.output_tokens === 20), label);
  }
});

// ===== v19, הכרעת הבעלים הסופית: Terra#2 נמדדת על הקריאה כולה =====
// מתי Terra#2 נשאלת — לא השתנה: שלב 3, וכל התנאים של הצד הזול (שתי זולות שנחלקו, ההתאמה לשורה המודפסת,
// זהות שאינה פתוחה, זיכוי והחזרות). איך היא מכריעה: Terra#2 קוראת את כל התעודה מחדש, והקריאה שלה כולה
// מושווית לקריאה של Terra כולה — אותן תעודות, אותו מספר שורות באותו סדר, ובכל שורה אותו מקטע, קוד, כמות,
// מחיר יחידה וסכום שורה, ואותם שדות סיכום שהקונצנזוס משווה (בלי תאריך התעודה), באותו נרמול של הקונצנזוס.
// זהה — כל שדה שנשאל ועומד ב-C1 וב-C2 נסגר (closedBy: 'second_strong_read'). הבדל אחד בכל מקום — שום דבר
// אינו נסגר, והשדות אצל העובד כמו היום (outcome: 'not_identical', וההבדלים הראשונים ב-differences).
const atRow = (index, changes, base = fourRowPaper) => doc({ ...base, rows: base.rows.map((item, at) => at === index ? { ...item, ...changes } : item) });
const cheapSplit = () => [answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper)];

test('v19 final rule: a whole read identical to Terra\'s closes every asked field — what the comparison does not measure does not block it', async () => {
  const same = [
    ['the same read', fourRowPaper],
    ['another description, confidence and warnings', doc({ ...atRow(0, { description: 'חלב', confidence: .3 }), confidence: .5, warnings: ['x'] })],
    ['another way of writing the date', doc({ ...fourRowPaper, docDate: '07/09/2026' })],
    ['a date that differs', doc({ ...fourRowPaper, docDate: '8.9.2026' })],
    ['an unreadable header (the consensus reads it as an invoice)', doc({ ...fourRowPaper, docType: 'unknown' })],
    ['a promotion star on another row', atRow(2, { promoStar: true })],
    ['its own line count', doc({ ...fourRowPaper, rows: fourRows().map(item => ({ ...item, lineNumber: item.lineNumber + 10 })) })],
    ['money within the agora and a quantity within a thousandth', atRow(1, { quantity: 6.0004, lineTotalExVat: 30.004 })],
  ];
  for (const [label, extra] of same) {
    const { output, calls } = await request([...cheapSplit(), answer(extra)]);
    assert.equal(calls.length, 4, label);
    const record = output.consensus.secondStrongRead;
    assert.deepEqual([record.outcome, record.stage, record.asked, record.differences, record.open], ['identical', 'second_strong_read', 2, [], []], label);
    assert.deepEqual(record.closed.map(item => [item.noteIndex, item.rowIndex, item.lineNumber, item.field, item.value, item.closedBy, item.reads.map(read => read.value)]), [
      [0, 1, 2, 'quantity', 6, 'second_strong_read', [6, 13, 17, extra.rows[1].quantity]],
      [0, 1, 2, 'lineTotalExVat', 30, 'second_strong_read', [30, 65, 85, extra.rows[1].lineTotalExVat]]], label);
    assert.ok(record.closed.every(item => !('rule' in item)), label);
    assert.deepEqual(output.consensus.disputedRows, [], label);
    // הערכים תמיד של Terra, והוא הקריאה שנבחרה.
    assert.deepEqual(output.scan.documents, [fourRowPaper], label);
    assert.equal(output.requestId, 'test-3', label);
  }
  // הכלל עצמו: מה נמדד ומה לא, באותו נרמול של הקונצנזוס.
  const differences = (a, b) => scanSecondStrongWholeReadDifferences(scan(a), scan(b));
  assert.deepEqual(differences(fourRowPaper, atRow(2, { sourcePage: 2, confidence: 0 })), []);
  assert.deepEqual(differences(fourRowPaper, atRow(2, { code: ' 333 ' })), []);
  assert.deepEqual(differences(fourRowPaper, atRow(2, { code: null })), [{ noteIndex: 0, scope: 'row', rowIndex: 2, lineNumber: 3, field: 'code', values: ['333', null] }]);
});

test('v19 final rule: one difference anywhere in Terra#2\'s whole read — another row, the order, the row count, a summary field — closes nothing', async () => {
  const v18 = await request(cheapSplit(), input, SECOND_OFF);
  const [r0, r1, r2, r3] = fourRows();
  const rowDiff = (rowIndex, field, values) => ({ noteIndex: 0, scope: 'row', rowIndex, lineNumber: rowIndex + 1, field, values });
  const docDiff = (field, values) => ({ noteIndex: 0, scope: 'document', field, values });
  const variants = [
    // השורה שנשאלה עצמה זהה בכולן חוץ מהראשונה; ההבדל הוא במקום אחר.
    ['a third value on the asked row', atRow(1, { quantity: 9, lineTotalExVat: 45 }), [rowDiff(1, 'quantity', [6, 9]), rowDiff(1, 'lineTotalExVat', [30, 45])]],
    ['another row\'s quantity and total', atRow(0, { quantity: 11, lineTotalExVat: 55 }), [rowDiff(0, 'quantity', [10, 11]), rowDiff(0, 'lineTotalExVat', [50, 55])]],
    ['one agora on another row', atRow(3, { lineTotalExVat: 3.01 }), [rowDiff(3, 'lineTotalExVat', [3, 3.01])]],
    ['another row\'s unit price', atRow(2, { unitPriceExVat: 4.5 }), [rowDiff(2, 'unitPriceExVat', [4, 4.5])]],
    ['another row\'s code', atRow(3, { code: '445' }), [rowDiff(3, 'code', ['444', '445'])]],
    ['another row read as returns', atRow(3, { section: 'returns' }), [rowDiff(3, 'section', ['items', 'returns'])]],
    // הסוג של השורה הוא חלק מהזהות שלה: פיקדון (לפי התיאור, כמו בכל מקום בשירות) מול מוצר.
    ['the asked row read as a deposit', atRow(1, { description: 'פיקדון בקבוק' }), [rowDiff(1, 'deposit', [false, true])]],
    ['two rows in another order', doc({ ...fourRowPaper, rows: [r0, r1, { ...r3, lineNumber: 3 }, { ...r2, lineNumber: 4 }] }),
      [rowDiff(2, 'code', ['333', '444']), rowDiff(2, 'quantity', [2, 1]), rowDiff(2, 'unitPriceExVat', [4, 3]), rowDiff(2, 'lineTotalExVat', [8, 3]),
        rowDiff(3, 'code', ['444', '333']), rowDiff(3, 'quantity', [1, 2]), rowDiff(3, 'unitPriceExVat', [3, 4]), rowDiff(3, 'lineTotalExVat', [3, 8])]],
    ['a row less', droppedRowPaper, [docDiff('rowCount', [4, 3])]],
    ['a row more', splitRowPaper, [docDiff('rowCount', [4, 5])]],
    ['the printed subtotal', doc({ ...fourRowPaper, subtotalExVat: 92 }), [docDiff('subtotalExVat', [91, 92])]],
    ['the items counter', doc({ ...fourRowPaper, itemsPrintedLines: 5 }), [docDiff('itemsPrintedLines', [4, 5])]],
    ['the VAT amount', doc({ ...fourRowPaper, vatAmount: 16.39 }), [docDiff('vatAmount', [16.38, 16.39])]],
    ['the promotion discount', doc({ ...fourRowPaper, promoDiscountExVat: 1 }), [docDiff('promoDiscountExVat', [null, 1])]],
    ['a credit note', doc({ ...fourRowPaper, docType: 'credit' }), [docDiff('docType', ['invoice', 'credit'])]],
    ['a minus on the subtotal', doc({ ...fourRowPaper, subtotalExVat: -91 }), [docDiff('subtotalExVat', [91, -91])]],
  ];
  for (const [label, extra, expected] of variants) {
    const { output, calls } = await request([...cheapSplit(), answer(extra)]);
    assert.equal(calls.length, 4, label + ': the field was asked');
    const record = output.consensus.secondStrongRead;
    assert.equal(record.outcome, 'not_identical', label);
    assert.deepEqual(record.closed, [], label);
    assert.deepEqual(record.differences, expected, label);
    assert.deepEqual(record.open.map(item => [item.lineNumber, item.field, item.reason]), [[2, 'quantity', 'not_identical'], [2, 'lineTotalExVat', 'not_identical']], label);
    // שירות 18: אותה קריאה נבחרת, אותה מחלוקת ואותה אזהרה.
    assert.deepEqual(output.scan, v18.output.scan, label);
    const { secondStrongRead: unusedRecord, ...rest } = output.consensus;
    assert.deepEqual(rest, v18.output.consensus, label);
    assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')), label);
  }
  // C4: בשדה שנשאר פתוח — הערך שנבחר ומה שכל קריאה זולה ראתה; Terra#2 אינה נרשמת לפי שדה (ההכרעה לא הייתה
  // על השדה), ומה שקראה אחרת — ב-differences. כאן היא קראה את השדה שנשאל כמו Terra, ושום דבר אינו נסגר.
  const elsewhere = await request([...cheapSplit(), answer(atRow(0, { quantity: 11, lineTotalExVat: 55 }))]);
  assert.deepEqual(elsewhere.output.consensus.secondStrongRead.open.map(item => item.reads),
    [strongReads(6, 13, 17).slice(0, 3), strongReads(30, 65, 85).slice(0, 3)]);
  // הרשימה נקטעת אחרי עשרה הבדלים — היומן אומר איפה התחיל ההבדל, לא את כל התעודה.
  const many = Array.from({ length: 30 }, (unused, index) => row({ code: String(500 + index), lineNumber: index + 1 }));
  const manyOther = many.map(item => ({ ...item, quantity: 11, lineTotalExVat: 55 }));
  assert.equal(scanSecondStrongWholeReadDifferences(scan(paper(many)), scan(doc({ ...paper(many), rows: manyOther }))).length, 10);
});

test('v19 final rule: a difference on another note of the scan closes nothing on this one', async () => {
  // שתי תעודות. בתעודה 0 הזולות נחלקו על שורה 2 ו-Terra#2 קראה אותה בדיוק כמו Terra; בתעודה 1 כולן קראו
  // 10 × 5, ורק Terra#2 קראה 11.
  const note1 = doc({ noteIndex: 1 });
  const both = (...documents) => ({ output_text: JSON.stringify({ documents, warnings: [] }) });
  const responses = () => [both(lunaThirteen, note1), both(lunaSeventeen, note1), both(fourRowPaper, note1)];
  const twoInputs = [input[0], { ...input[0], noteIndex: 1 }];
  const dark = await request(responses(), twoInputs, SECOND_OFF);
  const other = await request([...responses(), both(fourRowPaper, doc({ noteIndex: 1, rows: [row({ quantity: 11, lineTotalExVat: 55 })] }))], twoInputs);
  assert.equal(other.calls.length, 4);
  const record = other.output.consensus.secondStrongRead;
  assert.deepEqual([record.outcome, record.closed], ['not_identical', []]);
  assert.deepEqual(record.differences, [{ noteIndex: 1, scope: 'row', rowIndex: 0, lineNumber: 1, field: 'quantity', values: [10, 11] },
    { noteIndex: 1, scope: 'row', rowIndex: 0, lineNumber: 1, field: 'lineTotalExVat', values: [50, 55] }]);
  assert.deepEqual(other.output.consensus.disputedRows, dark.output.consensus.disputedRows);
  // אותה Terra#2 עם תעודה 1 כמו Terra: הקריאה כולה זהה, והשדות של תעודה 0 נסגרים.
  const same = await request([...responses(), both(fourRowPaper, note1)], twoInputs);
  assert.deepEqual(same.output.consensus.secondStrongRead.closed.map(item => [item.noteIndex, item.lineNumber, item.field]), [[0, 2, 'quantity'], [0, 2, 'lineTotalExVat']]);
  assert.deepEqual(same.output.consensus.disputedRows, []);
});

test('v19 final rule: C1 and C2 still decide what an identical read may close — never the code, the star, a summary, a deposit, returns or a credit note', async () => {
  const selected = { stage: 'consensus_escalation', scan: scan(fourRowPaper) };
  const witnesses = [{ stage: 'consensus_1', scan: scan(lunaThirteen) }, { stage: 'consensus_2', scan: scan(lunaSeventeen) }];
  const places = scanSecondStrongPlan(selected, witnesses, input).places;
  assert.deepEqual(places.map(item => item.field), ['quantity', 'lineTotalExVat']);
  const closures = (selectedScan, extraScan, asked = places) => scanSecondStrongReadClosures({ stage: 'consensus_escalation', scan: selectedScan },
    extraScan && { stage: 'second_strong_read', scan: extraScan }, asked, input);
  assert.deepEqual(closures(scan(fourRowPaper), scan(fourRowPaper)).closed.map(item => item.field), ['quantity', 'lineTotalExVat']);
  // C1: הנייר שנבחר אינו נסגר, או שהחשבון של השורה עצמה אינו נסגר — גם מול קריאה זהה, שום דבר אינו נסגר.
  for (const [label, failing] of [['the paper does not close', doc({ ...fourRowPaper, subtotalExVat: 92 })],
    ['the row arithmetic does not close', rowTwo({ unitPriceExVat: 5.5 })], ['the counter was not read', doc({ ...fourRowPaper, itemsPrintedLines: null })]]) {
    const result = closures(scan(failing), scan(failing));
    assert.deepEqual(result.differences, [], label);
    assert.deepEqual(result.closed, [], label);
    assert.deepEqual(result.open.map(item => item.reason), ['not_eligible', 'not_eligible'], label);
  }
  // C2: קוד, כוכבית, עמוד, שורה וסיכום — לעולם לא; וגם לא שורת פיקדון, החזרות או זיכוי.
  const place = field => ({ noteIndex: 0, rowIndex: 1, page: 1, lineNumber: 2, field });
  for (const field of ['code', 'promoStar', 'sourcePage', 'section', 'row', 'subtotalExVat', 'rowCount']) {
    assert.deepEqual(closures(scan(fourRowPaper), scan(fourRowPaper), [place(field)]).open.map(item => [item.field, item.reason]), [[field, 'not_eligible']], field);
  }
  const deposit = rowTwo({ description: 'פיקדון בקבוק' });
  const credit = doc({ ...fourRowPaper, docType: 'credit', subtotalExVat: -91, vatAmount: -16.38, totalInclVat: -107.38 });
  const mixed = doc({ ...fourRowPaper, subtotalExVat: 81, returnsSectionTotalExVat: 10, returnsPrintedLines: 1,
    rows: [...fourRows(), row({ section: 'returns', lineNumber: 5, quantity: 2, lineTotalExVat: 10 })] });
  for (const [label, kind] of [['deposit', deposit], ['credit', credit], ['mixed', mixed]]) {
    assert.deepEqual(closures(scan(kind), scan(kind)).closed, [], label);
  }
  // Terra#2 נכשלה: שום דבר אינו נסגר.
  assert.deepEqual(closures(scan(fourRowPaper), null).open.map(item => item.reason), ['failed', 'failed']);
  // מקצה לקצה: בשורה 2 הכמות והסכום נשאלים ונסגרים; הקוד שבמחלוקת בשורה 4 (מאושר בזולה אחת) והכוכבית
  // שבמחלוקת בשורה 2 אינם נשאלים ונשארים כמו בשירות 18 — גם כש-Terra#2 זהה ל-Terra.
  const responses = () => [answer(atRow(3, { code: '445' }, rowTwo({ quantity: 13, lineTotalExVat: 65, promoStar: true }))),
    answer(rowTwo({ quantity: 17, lineTotalExVat: 85, promoStar: true })), answer(fourRowPaper)];
  const dark = await request(responses(), input, SECOND_OFF);
  const lit = await request([...responses(), answer(fourRowPaper)]);
  assert.deepEqual(dark.output.consensus.disputedRows.map(item => [item.lineNumber, item.fields.map(field => [field.field, field.confirmed])]),
    [[2, [['quantity', 0], ['lineTotalExVat', 0], ['promoStar', 0]]], [4, [['code', 1]]]]);
  assert.deepEqual(lit.output.consensus.secondStrongRead.closed.map(item => [item.lineNumber, item.field]), [[2, 'quantity'], [2, 'lineTotalExVat']]);
  assert.deepEqual(lit.output.consensus.disputedRows.map(item => [item.lineNumber, item.fields.map(field => [field.field, field.confirmed])]),
    [[2, [['promoStar', 0]]], [4, [['code', 1]]]]);
});

test('v19: a second strong read that reads a third value, misses the row or fails changes nothing, and never adds a dispute', async () => {
  const v18 = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper)], input, SECOND_OFF);
  assert.equal(v18.calls.length, 3);
  assert.deepEqual(v18.output.consensus.disputedRows, v18Dispute);
  const withoutRow = doc({ ...fourRowPaper, rows: fourRows().filter((item, index) => index !== 1) });
  // הכרעת הבעלים הסופית: ערך שלישי או שורה חסרה הם הבדל בקריאה כולה (not_identical). בשדה הפתוח רשומים
  // הערך שנבחר והזולות; מה ש-Terra#2 קראה אחרת — ב-differences.
  for (const [strong2, outcome, error, reason, first] of [
    [answer(rowTwo({ quantity: 9, lineTotalExVat: 45 })), 'not_identical', undefined, 'not_identical',
      { noteIndex: 0, scope: 'row', rowIndex: 1, lineNumber: 2, field: 'quantity', values: [6, 9] }],
    [answer(withoutRow), 'not_identical', undefined, 'not_identical', { noteIndex: 0, scope: 'document', field: 'rowCount', values: [4, 3] }],
    [new Error('test network failure'), 'failed', 'openai_network_error', 'failed', undefined],
    [{ output_text: 'invalid json' }, 'failed', 'invalid_model_output', 'failed', undefined]]) {
    const label = outcome + ' ' + reason + ' ' + error;
    const { output, calls } = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), strong2]);
    assert.equal(calls.length, 4, label + ': one call, never retried');
    assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
      [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true], ['second_strong_read', false]], label);
    const record = output.consensus.secondStrongRead;
    assert.equal(record.outcome, outcome, label);
    assert.equal(record.error, error, label);
    assert.deepEqual(record.closed, [], label);
    assert.deepEqual(record.open.map(item => [item.field, item.reason, item.value, item.reads]),
      [['quantity', reason, 6, strongReads(6, 13, 17).slice(0, 3)], ['lineTotalExVat', reason, 30, strongReads(30, 65, 85).slice(0, 3)]], label);
    assert.deepEqual(record.differences[0], first, label);
    // הקריאה שנבחרה, המחלוקת והאזהרה — בדיוק של שירות 18.
    assert.deepEqual(output.scan, v18.output.scan, label);
    const { secondStrongRead: unusedRecord, ...rest } = output.consensus;
    assert.deepEqual(rest, v18.output.consensus, label);
    assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')), label);
  }
  // היא אינה עדה ואינה מוסיפה מחלוקת: קוד אחר שקראה בשורה שכל השאר מסכימים עליה אינו נעשה מחלוקת. מהכרעת
  // הבעלים הסופית הוא כן הבדל בקריאה כולה — ולכן גם שום דבר אינו נסגר (עד כאן הכמות והסכום של שורה 2 נסגרו כאן).
  const otherCode = doc({ ...fourRowPaper, docDate: '1.9.2026', rows: fourRows().map((item, index) => index === 0 ? row({ ...item, code: '119' }) : item) });
  const { output } = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(otherCode)]);
  assert.deepEqual(output.consensus.secondStrongRead.closed, []);
  assert.deepEqual(output.consensus.secondStrongRead.differences, [{ noteIndex: 0, scope: 'row', rowIndex: 0, lineNumber: 1, field: 'code', values: ['111', '119'] }]);
  assert.deepEqual(output.consensus.disputedRows, v18Dispute);
  assert.deepEqual(output.consensus.docDateUnconfirmed, []);
  assert.deepEqual(output.consensus.missingRows, []);
  // ותאריך אחר בלבד (שאינו נמדד): השדות נסגרים, והתאריך של Terra אינו נעשה "לא מאושר".
  const otherDate = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(doc({ ...fourRowPaper, docDate: '1.9.2026' }))]);
  assert.deepEqual(otherDate.output.consensus.secondStrongRead.closed.map(item => item.field), ['quantity', 'lineTotalExVat']);
  assert.deepEqual(otherDate.output.consensus.disputedRows, []);
  assert.deepEqual(otherDate.output.consensus.docDateUnconfirmed, []);
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
  // מקצה לקצה: הכמות והסכום נסגרים, והכוכבית שבמחלוקת נשארת בדיוק כפי שהייתה — אצל העובד —
  // גם כשהקריאה השנייה קוראת אותה כמו Terra.
  const { output, calls } = await request([answer(rowTwo({ promoStar: true, quantity: 13, lineTotalExVat: 65 })),
    answer(rowTwo({ promoStar: true, quantity: 17, lineTotalExVat: 85 })), answer(fourRowPaper), answer(fourRowPaper)]);
  assert.equal(calls.length, 4);
  const note = calls[3].input[1].content.at(-1).text;
  assert.ok(note.includes('שורה 2: quantity, lineTotalExVat.') && !note.includes('code') && !note.includes('promoStar'), note);
  assert.deepEqual(output.consensus.secondStrongRead.closed.map(item => item.field), ['quantity', 'lineTotalExVat']);
  assert.deepEqual(output.consensus.disputedRows.map(item => [item.rowIndex, bare(item.fields)]),
    [[1, [{ field: 'promoStar', selected: false, other: true, confirmed: 0 }]]]);
  assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')), 'the star still goes to the worker');
  // וקוד שבמחלוקת נשאר כפי שהיה, עם הכמות והכסף של השורה: מהביקורת (סבב שלישי), קריאה זולה שקראה
  // בשורה 2 קוד אחר (228) לא קראה את השורה המודפסת של Terra, ולכן אין שתי זולות שנחלקו עליה — השדות
  // אינם נשאלים (lone). שורה שהזהות שלה פתוחה (confirmed 0) אינה נשאלת ממילא — ראו את הבדיקה
  // "a row whose identity is still open".
  const otherCodeResponses = () => [answer(rowTwo({ promoStar: true, quantity: 13, lineTotalExVat: 65 })),
    answer(rowTwo({ code: '228', promoStar: true, quantity: 17, lineTotalExVat: 85 })), answer(fourRowPaper)];
  const otherCodeDark = await request(otherCodeResponses(), input, SECOND_OFF);
  const otherCode = await request([...otherCodeResponses(), answer(fourRowPaper)]);
  assert.equal(otherCode.calls.length, 3);
  assert.deepEqual(comparable(otherCode.output), comparable(otherCodeDark.output));
  assert.deepEqual(otherCode.output.consensus.disputedRows.map(item => [item.rowIndex, item.fields.map(field => [field.field, field.confirmed])]),
    [[1, [['code', 1], ['quantity', 0], ['lineTotalExVat', 0], ['promoStar', 0]]]]);
  assert.deepEqual(otherCode.output.consensus.secondStrongRead.notAsked.map(item => [item.field, item.reason]), [['quantity', 'lone'], ['lineTotalExVat', 'lone']]);
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
  // הקוד של Terra מאושר בקריאה זולה אחת (2 מתוך 3, שלב 2): הזהות סגורה. אבל מהביקורת (סבב שלישי)
  // הקריאה הזולה שקראה בשורה 2 את 229 לא קראה את השורה המודפסת של Terra (קוד אחר באותה שורה), ולכן
  // אין שתי זולות שנחלקו על הכמות והסכום שלה — הם אינם נשאלים (lone), ונשארים לעובד יחד עם הקוד,
  // שנשאר ברשימה עם confirmed 1, בדיוק כמו בשירות 18.
  const settledResponses = () => [answer(lunaThirteen), answer(rowTwo({ code: '229', quantity: 17, lineTotalExVat: 85 })), answer(fourRowPaper)];
  const settledDark = await request(settledResponses(), input, SECOND_OFF);
  const settled = await request([...settledResponses(), answer(fourRowPaper)]);
  assert.equal(settled.calls.length, 3);
  assert.deepEqual(comparable(settled.output), comparable(settledDark.output));
  assert.deepEqual(settled.output.consensus.secondStrongRead.notAsked.map(item => [item.lineNumber, item.field, item.reason, item.reads.at(-1)]),
    [[2, 'quantity', 'lone', { stage: 'consensus_2', value: null, seen: false, unmatched: 'other_code' }],
      [2, 'lineTotalExVat', 'lone', { stage: 'consensus_2', value: null, seen: false, unmatched: 'other_code' }]]);
  assert.deepEqual(settled.output.consensus.disputedRows.map(item => item.fields.map(field => [field.field, field.selected, field.other, field.confirmed])),
    [[['code', '222', '229', 1], ['quantity', 6, 13, 0], ['lineTotalExVat', 30, 65, 0]]]);
  // כששתי הזולות קראו את השורה המודפסת של Terra (קוד 222) ונחלקו עליה, השדות נשאלים ונסגרים — ראו
  // את הבדיקה הראשונה של שירות 19.
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
  assert.deepEqual(logged.closed.map(item => [item.noteIndex, item.page, item.lineNumber, item.field, item.reads.map(read => read.stage + '=' + read.value).join(' '), item.closedBy]), [
    [0, 1, 2, 'quantity', 'consensus_escalation=6 consensus_1=13 consensus_2=17 second_strong_read=6', 'second_strong_read'],
    [0, 1, 2, 'lineTotalExVat', 'consensus_escalation=30 consensus_1=65 consensus_2=85 second_strong_read=30', 'second_strong_read']]);
  assert.deepEqual([logged.model, logged.requestId, logged.usage], ['gpt-5.6-terra', 'test-4', { input_tokens: 10, output_tokens: 20 }]);
  // התשובה עצמה אינה משתנה: אותה רשומה, בלי מזהה הסריקה, בקונצנזוס וביומן הסריקה.
  assert.ok(!('scanAuditId' in output.consensus.secondStrongRead));
  assert.deepEqual(output.scanAudit.secondStrongRead, output.consensus.secondStrongRead);
  // שדה שנשאר לעובד נרשם באותה צורה, עם הסיבה — וההבדלים הראשונים בין הקריאות, עם הערך של כל אחת.
  const left = await printedLog([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(rowTwo({ quantity: 9, lineTotalExVat: 45 }))]);
  const leftLine = left.text.split('\n').find(line => line.includes('secondStrongRead'));
  const leftLogged = JSON.parse(leftLine.trim().replace(/^secondStrongRead: /, '').replace(/,$/, ''));
  assert.equal(leftLogged.outcome, 'not_identical');
  assert.deepEqual(leftLogged.open.map(item => [item.lineNumber, item.field, item.reason, item.reads.map(read => read.value)]),
    [[2, 'quantity', 'not_identical', [6, 13, 17]], [2, 'lineTotalExVat', 'not_identical', [30, 65, 85]]]);
  assert.deepEqual(leftLogged.differences.map(item => [item.rowIndex, item.field, item.values]), [[1, 'quantity', [6, 9]], [1, 'lineTotalExVat', [30, 45]]]);
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
  assert.deepEqual(output.consensus.disputedRows.map(item => bare(item.fields)),
    [[{ field: 'quantity', selected: 6, other: 13, confirmed: 0 }, { field: 'lineTotalExVat', selected: 30, other: 65, confirmed: 0 }]]);
  // והסגירה עצמה (הכרעת הבעלים הסופית): רק קריאה זהה כולה סוגרת, והערך תמיד של הקריאה שנבחרה. עד כאן
  // קריאה שקראה 6 בכמות ו-31 בסכום סגרה את הכמות לבדה; עכשיו הסכום השונה הוא הבדל, ושום דבר אינו נסגר.
  const places = scanSecondStrongOpenFields(scan(fourRowPaper), [scan(lunaThirteen), scan(lunaSeventeen)], input);
  const closures = extra => scanSecondStrongReadClosures({ stage: 'consensus_escalation', scan: scan(fourRowPaper) }, extra, places, input);
  assert.deepEqual(closures({ stage: 'second_strong_read', scan: scan(lunaSeventeen) }).closed, []);
  assert.deepEqual(closures({ stage: 'second_strong_read', scan: scan(rowTwo({ quantity: 6, lineTotalExVat: 31 })) }).closed, []);
  assert.deepEqual(closures({ stage: 'second_strong_read', scan: scan(fourRowPaper) }).closed.map(item => [item.field, item.value]), [['quantity', 6], ['lineTotalExVat', 30]]);
  assert.deepEqual(closures(null).open.map(item => item.reason), ['failed', 'failed']);
});

// ===== v19, מהביקורת: הקריאה השנייה מצביעה רק על השורה המודפסת שנשאלה =====
// הקול של הקריאה השנייה נלקח מהשורה שלה שמיושרת מול השורה של Terra — לפי מיקום כשמספר
// השורות שווה, ולפי תוכן כשאינו שווה. קריאה שנייה שדילגה על השורה שנשאלה מיושרת כך מול
// שורה שכנה באותו מחיר, וקראה בה בדיוק את מה ש-Terra שם בשורה שנשאלה — כש-Terra החליף
// בין שני תאומים. היא מעולם לא ראתה את השורה, והשדה נשאר לעובד.
// מהכרעת הבעלים הסופית אין קול לפי שורה: קריאה כזאת אינה זהה ל-Terra בקריאה כולה (שורה חסרה, או
// קודים ומספרים אחרים בשורות 2 עד 4), ולכן שום דבר אינו נסגר — אותו תרחיש, אותה תוצאה לעובד.
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
    // C4: הרשומה אינה מייחסת לקריאה השנייה ערך בשורה 2; ההבדל הראשון שלה נרשם.
    assert.deepEqual(record.open.map(item => [item.lineNumber, item.field, item.reason, item.reads.length]), [
      [2, 'quantity', 'not_identical', 3], [2, 'lineTotalExVat', 'not_identical', 3]], label);
    assert.deepEqual(record.differences[0], extra.rows.length === 3 ? { noteIndex: 0, scope: 'document', field: 'rowCount', values: [4, 3] }
      : { noteIndex: 0, scope: 'row', rowIndex: 1, lineNumber: 2, field: 'code', values: ['14761056', '14761414'] }, label);
  }
  // אותו קוד בשתי השורות: הקוד אינו אומר איזו שורה מודפסת קריאה קראה, ולכן הוא אינו מזהה את
  // השורה. מהביקורת (סבב שלישי) השדה לכן אינו נשאל כלל, ואין קריאה רביעית בתשלום (not_matchable,
  // ראו "when the selected row cannot be matched") — וזה נשאר, כי הכלל של הצד הזול אינו יכול לדעת
  // אם הזולות נחלקו על אותה שורה מודפסת.
  const same = ['222', '222'];
  const plan = scanSecondStrongPlan({ stage: 'consensus_escalation', scan: scan(swapped(same)) },
    [{ stage: 'consensus_1', scan: scan(cheap(8, same)) }, { stage: 'consensus_2', scan: scan(cheap(9, same)) }], input);
  assert.deepEqual(scanSecondStrongOpenFields(scan(swapped(same)), [scan(cheap(8, same)), scan(cheap(9, same))], input), []);
  assert.deepEqual(plan.places, []);
  // שורה 3 (6 בשתי הזולות) — גם היא נושאת את 222, ולכן גם היא אינה ניתנת להתאמה, עוד לפני שהזולות הסכימו.
  assert.deepEqual(plan.notAsked.map(item => [item.lineNumber, item.field, item.reason, item.unmatched]),
    [[2, 'quantity', 'not_matchable', 'code_repeated'], [2, 'lineTotalExVat', 'not_matchable', 'code_repeated'],
      [3, 'quantity', 'not_matchable', 'code_repeated'], [3, 'lineTotalExVat', 'not_matchable', 'code_repeated']]);
  // מקצה לקצה: אין קריאה רביעית בתשלום, גם כשהיא הייתה קוראת בדיוק כמו Terra.
  const sameResponses = () => [answer(cheap(8, same)), answer(cheap(9, same)), answer(swapped(same))];
  const sameDark = await request(sameResponses(), input, SECOND_OFF, APP_142);
  const sameLit = await request([...sameResponses(), answer(swapped(same))], input, {}, APP_142);
  assert.equal(sameLit.calls.length, 3);
  assert.deepEqual(comparable(sameLit.output), comparable(sameDark.output));
  assert.equal(sameLit.output.consensus.secondStrongRead.outcome, 'not_matchable');
  // הקריאה השנייה קראה בשורה 2 קוד אחר מזה של Terra: הקריאה כולה אינה זהה, ושום דבר אינו נסגר.
  const closures = extra => scanSecondStrongReadClosures({ stage: 'consensus_escalation', scan: scan(fourRowPaper) },
    { stage: 'second_strong_read', scan: scan(extra) },
    scanSecondStrongOpenFields(scan(fourRowPaper), [scan(lunaThirteen), scan(lunaSeventeen)], input), input);
  assert.deepEqual(closures(rowTwo({ code: '229' })).closed, []);
  assert.deepEqual(closures(rowTwo({ code: '229' })).open.map(item => [item.field, item.reason]), [['quantity', 'not_identical'], ['lineTotalExVat', 'not_identical']]);
  assert.deepEqual(closures(rowTwo({ code: '229' })).differences, [{ noteIndex: 0, scope: 'row', rowIndex: 1, lineNumber: 2, field: 'code', values: ['222', '229'] }]);
  // מהביקורת (סבב רביעי): קריאה שנייה שפספסה שורה אחרת (שורה 3), גם כשבשורה 2 קראה אותו קוד ואותו ערך —
  // השדה נשאר לעובד. מהכרעת הבעלים הסופית: מספר שורות אחר הוא הבדל בקריאה כולה.
  assert.deepEqual(closures(droppedRowPaper).closed, []);
  assert.deepEqual(closures(droppedRowPaper).open.map(item => [item.lineNumber, item.field, item.reason]), [
    [2, 'quantity', 'not_identical'], [2, 'lineTotalExVat', 'not_identical']]);
  assert.deepEqual(closures(droppedRowPaper).differences, [{ noteIndex: 0, scope: 'document', field: 'rowCount', values: [4, 3] }]);
  const missedOther = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(droppedRowPaper)]);
  assert.deepEqual(missedOther.output.consensus.secondStrongRead.closed, []);
  assert.deepEqual(missedOther.output.consensus.disputedRows, v18Dispute);
});

test('v19 (a): when the selected paper fails, the checksum-retry slot is service 18\'s — the same note, the same answer, and nothing closes from it', async () => {
  // שתי תעודות: בראשונה הקריאות נחלקו על שורה 2 ו-Terra נסגר; בשנייה "סהכ חייב מעמ" נקרא 49 בכל
  // הקריאות, ולכן קריאת ההצלה יוצאת. הכרעת הבעלים הסופית: Terra#2 סוגרת רק כשהנייר שנבחר כבר נסגר
  // (המקרה (b), שלב second_strong_read); כשהוא נכשל, המשבצת המשותפת מתנהגת בדיוק כמו בשירות 18 — בלי
  // מקומות בהנחיה ובלי סגירות ממנה, גם כשקריאת ההצלה קוראת את התעודה הראשונה בדיוק כמו Terra. (עד כאן
  // ההנחיה שלה נשאה את המקומות, והיא הצביעה.)
  const twoDocs = [{ ...input[0] }, { ...input[0], noteIndex: 1 }];
  const pair = (first, second) => ({ output_text: JSON.stringify({ documents: [first, second], warnings: [] }) });
  const short = doc({ noteIndex: 1, subtotalExVat: 49 });
  const responses = retry => [pair(lunaThirteen, short), pair(lunaSeventeen, short), pair(fourRowPaper, short), retry];
  for (const [label, retry, selected] of [['the retry loses', pair(fourRowPaper, short), false], ['the retry wins', pair(fourRowPaper, doc({ noteIndex: 1 })), true]]) {
    const off = await request(responses(retry), twoDocs, SECOND_OFF);
    const on = await request(responses(retry), twoDocs);
    for (const run of [off, on]) {
      assert.equal(run.calls.length, 4, label + ': still four calls at most');
      assert.deepEqual(run.output.scanAudit.attempts.map(a => [a.stage, a.selected]),
        [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', !selected], ['checksum_retry', selected]], label);
      assert.equal(run.output.checksumRetryAttempted, true, label);
    }
    // אותן בקשות בדיוק — גם ההנחיה של קריאת ההצלה — ואותה תשובה, חוץ מהרשומה.
    assert.deepEqual(on.calls, off.calls, label);
    assert.ok(on.calls[3].input[1].content.at(-1).text.startsWith('אזהרת סכום ביקורת') && !on.calls[3].input[1].content.at(-1).text.includes('בנוסף'), label);
    assert.deepEqual(comparable(on.output), comparable(off.output), label);
    assert.deepEqual(on.output.consensus.disputedRows, selected ? [] : v18Dispute, label);
    // C4: למה שום דבר לא נסגר — השדות שהיו נשאלים נרשמים עם הסיבה, ואין קריאה רביעית.
    const record = on.output.consensus.secondStrongRead;
    assert.deepEqual([record.outcome, record.stage, record.asked, record.closed, record.open, record.differences], ['checksum_retry_slot', null, 0, [], [], []], label);
    assert.deepEqual(record.notAsked.map(item => [item.noteIndex, item.lineNumber, item.field, item.reason, item.reads.map(read => read.value)]), [
      [0, 2, 'quantity', 'checksum_retry_slot', [6, 13, 17]], [0, 2, 'lineTotalExVat', 'checksum_retry_slot', [30, 65, 85]]], label);
  }
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
    assert.equal(status.serviceVersion, 20, JSON.stringify(extraEnv));
    assert.equal(status.secondStrongRead, expected, JSON.stringify(extraEnv));
  }
});

// ===== v19, מהביקורת (סבב שלישי): כל קריאה נספרת רק לשורה המודפסת שנשאלה =====
// עד כאן "מה קריאה ראתה בשורה שנשאלה" נלקח מהיישור של diffs: לפי מיקום כשמספר השורות שווה,
// ולפי תוכן כשאינו שווה. קריאה שמשנה סדר, מדלגת על שורה ומכפילה אחרת, או מסיטה את עמודת הקוד
// מיושרת כך מול שורה מודפסת אחרת — והתנאים של הצד הזול וגם הקול של הקריאה השנייה נלקחו משם.
// בשלב 3 בלבד: קריאה נספרת לשורה שנשאלה רק כשיש לה בדיוק שורה אחת באותו עמוד ובאותו מספר שורה
// מודפס, באותו קוד של השורה שנבחרה, וקוד שמופיע בתעודה בשורה אחת בלבד — בקריאה שנבחרה ובשלה.
// הנייר: ארבע שורות, 98.11 ₪; בשורות 2 ו-3 שני תאומים ב-3.47 — 7 יחידות (24.29) ו-6 (20.82).
const twinRows = (codes = ['14761056', '14761414']) => [row({ code: '111', lineNumber: 1 }),
  row({ code: codes[0], lineNumber: 2, quantity: 7, unitPriceExVat: 3.47, lineTotalExVat: 24.29 }),
  row({ code: codes[1], lineNumber: 3, quantity: 6, unitPriceExVat: 3.47, lineTotalExVat: 20.82 }),
  row({ code: '444', lineNumber: 4, quantity: 1, unitPriceExVat: 3, lineTotalExVat: 3 })];
const twinPaper = paper(twinRows());
const twinRead = rows => doc({ ...twinPaper, rows });
// הכמות (והסכום בהתאם) של שורה מודפסת אחת.
const twinQuantity = (quantity, lineNumber = 2, rows = twinRows()) => rows.map(item => item.lineNumber === lineNumber
  ? { ...item, quantity, lineTotalExVat: Math.round(quantity * 347) / 100 } : item);
const placesOf = entries => entries.map(item => [item.lineNumber, item.field, item.reason]);

test('v19: a cheap read that skipped a line is not read at a neighbouring line — two cheap reads that read the asked line alike are never outvoted', async () => {
  // Terra (נבחר, הנייר שלו נסגר) העביר יחידה בין התאומים: שורה 2 = 8, שורה 3 = 5.
  const moved = twinRead(twinQuantity(5, 3, twinQuantity(8, 2)));
  assert.equal(tnuvaPaperCheck(moved, 1).receivable, true);
  // קריאה זולה 1 דילגה על שורה 1 וראתה שורה נוספת בסוף: אותו מספר שורות, ולכן היישור לפי מיקום מצמיד
  // לשורה 2 של Terra את שורה 3 המודפסת שלה. אבל היא קראה את שורות 2 ו-3 כמו המודפס (7 ו-6), כמו הזולה השנייה.
  const skipped = twinRead([...twinRows().slice(1), row({ code: '9999', lineNumber: 5, quantity: 2, unitPriceExVat: 1, lineTotalExVat: 2 })]);
  const exact = twinRead(twinRows().map(item => item.lineNumber === 4 ? { ...item, code: '445' } : item));
  for (const extraBody of [{}, APP_142]) {
    const label = JSON.stringify(extraBody);
    const dark = await request([answer(skipped), answer(exact), answer(moved)], input, SECOND_OFF, extraBody);
    const lit = await request([answer(skipped), answer(exact), answer(moved), answer(moved)], input, {}, extraBody);
    // שירות 18: לפי היישור אף זולה אינה מאשרת את 8 ואת 5 — והשדות אצל העובד. כך גם כאן.
    assert.deepEqual(dark.output.consensus.disputedRows.filter(item => [2, 3].includes(item.lineNumber))
      .map(item => [item.lineNumber, item.fields.filter(field => field.field === 'quantity').map(field => [field.selected, field.confirmed])]),
      [[2, [[8, 0]]], [3, [[5, 0]]]], label);
    assert.equal(lit.calls.length, 3, label + ': no second strong read');
    assert.deepEqual(lit.calls, dark.calls, label);
    assert.deepEqual(comparable(lit.output), comparable(dark.output), label);
    const record = lit.output.consensus.secondStrongRead;
    assert.deepEqual([record.outcome, record.asked, record.closed, record.open], ['not_needed', 0, [], []], label);
    // C4: למה לא נשאל. מהביקורת (סבב רביעי): הטבלה של הזולה שדילגה אינה מתיישרת עם זו של Terra (השורות
    // שלה הן 2 עד 5), ולכן היא אינה נקראת בשורה 2 כלל — גם כשבמקרה קראה אותה נכון — והזולה השנייה, שקראה
    // את המודפס, לבד. גם כך השדה אינו נשאל: אף קריאה זולה שקראה את השורה אינה מוכרעת בשתי קריאות חזקות.
    const skippedVote = { stage: 'consensus_1', value: null, seen: false, unmatched: 'lines_differ' };
    assert.deepEqual(record.notAsked.map(item => [item.lineNumber, item.field, item.reason, item.reads.map(read => read.value)]), [
      [2, 'quantity', 'lone', [8, null, 7]], [2, 'lineTotalExVat', 'lone', [27.76, null, 24.29]],
      [3, 'quantity', 'lone', [5, null, 6]], [3, 'lineTotalExVat', 'lone', [17.35, null, 20.82]]], label);
    assert.deepEqual(record.notAsked.map(item => item.reads[1]), [skippedVote, skippedVote, skippedVote, skippedVote], label);
    assert.deepEqual(record.notAsked[0].reads.map(read => read.stage), ['consensus_escalation', 'consensus_1', 'consensus_2'], label);
  }
});

test('v19: a cheap reading that was not read or not matched leaves its field with the worker — field by field', async () => {
  // קריאה זולה 1 לא קראה את הכמות בשורה 2, רק את הסכום. הכמות — קריאה זולה אחת, אצל העובד; הסכום, שבו
  // שתי הזולות נחלקו, נשאל ונסגר.
  const noQuantity = rowTwo({ quantity: null, lineTotalExVat: 65 });
  const dark = await request([answer(noQuantity), answer(lunaSeventeen), answer(fourRowPaper)], input, SECOND_OFF);
  const lit = await request([answer(noQuantity), answer(lunaSeventeen), answer(fourRowPaper), answer(fourRowPaper)]);
  assert.equal(lit.calls.length, 4);
  const note = lit.calls[3].input[1].content.at(-1).text;
  assert.ok(note.includes('שורה 2: lineTotalExVat.') && !note.includes('quantity'), note);
  const record = lit.output.consensus.secondStrongRead;
  assert.deepEqual(record.closed.map(item => [item.lineNumber, item.field, item.value]), [[2, 'lineTotalExVat', 30]]);
  assert.deepEqual(record.notAsked.map(item => [item.lineNumber, item.field, item.reason, item.reads.map(read => read.value)]),
    [[2, 'quantity', 'lone', [6, null, 17]]]);
  assert.deepEqual(lit.output.consensus.disputedRows.map(item => bare(item.fields)),
    [dark.output.consensus.disputedRows[0].fields.filter(field => field.field !== 'lineTotalExVat')]);
  // קריאה זולה 1 קראה בשורה 2 את הקוד של שורה 3 (הסטה של עמודת הקוד): זו לא השורה המודפסת שנשאלה.
  // לפי היישור הקוד של Terra עדיין מאושר בזולה 2, אבל בשלב 3 נשארה רק קריאה זולה אחת של השורה —
  // אין "נחלקו", ואין קריאה רביעית בתשלום.
  const shifted = rowTwo({ code: '333', quantity: 13, lineTotalExVat: 65 });
  const shiftedDark = await request([answer(shifted), answer(lunaSeventeen), answer(fourRowPaper)], input, SECOND_OFF);
  const shiftedLit = await request([answer(shifted), answer(lunaSeventeen), answer(fourRowPaper), answer(fourRowPaper)]);
  assert.deepEqual(shiftedDark.output.consensus.disputedRows.map(item => item.fields.map(field => [field.field, field.confirmed])),
    [[['code', 1], ['quantity', 0], ['lineTotalExVat', 0]]]);
  assert.equal(shiftedLit.calls.length, 3);
  assert.deepEqual(shiftedLit.calls, shiftedDark.calls);
  assert.deepEqual(comparable(shiftedLit.output), comparable(shiftedDark.output));
  const shiftedRecord = shiftedLit.output.consensus.secondStrongRead;
  assert.equal(shiftedRecord.outcome, 'not_needed');
  assert.deepEqual(placesOf(shiftedRecord.notAsked), [[2, 'quantity', 'lone'], [2, 'lineTotalExVat', 'lone']]);
  assert.deepEqual(shiftedRecord.notAsked[0].reads, [{ stage: 'consensus_escalation', value: 6, selected: true },
    { stage: 'consensus_1', value: null, seen: false, unmatched: 'other_code' }, { stage: 'consensus_2', value: 17 }]);
});

test('v19: the second strong read counts only with its own single row at the asked page and line, under the same code printed once — a shifted code column or a doubled line confirms nothing', async () => {
  // הזולות נחלקו על שורה 2 (8 ו-9) וקראו את שורה 3 כמו המודפס. Terra החליף בין התאומים (6 ו-7):
  // הנייר שלו והחשבון של כל שורה עדיין נסגרים, והקוד של כל שורה מאושר בשתי הזולות.
  const cheap = quantity => twinRead(twinQuantity(quantity));
  const swapped = twinRead(twinQuantity(7, 3, twinQuantity(6, 2)));
  const responses = () => [answer(cheap(8)), answer(cheap(9)), answer(swapped)];
  const dark = await request(responses(), input, SECOND_OFF, APP_142);
  assert.deepEqual(dark.output.consensus.disputedRows.map(item => item.lineNumber), [2, 3]);
  const p = twinRows();
  // הקריאה הרביעית קוראת את כל הכמויות נכון — בשורה 2: 7 — אבל לא את השורה המודפסת 2 של Terra.
  const variants = [
    // הכשל הידוע: עמודת הקוד הוסטה שורה אחת למטה, ונוספה שורה בסוף (מספר שורות שונה — יישור לפי תוכן).
    ['code column shifted, one extra row', [p[0], { ...p[1], code: '5' }, { ...p[2], code: '14761056' }, { ...p[3], code: '14761414' }, { ...p[3], code: '444', lineNumber: 5 }], 'other_code'],
    ['code column shifted, same row count', [p[0], { ...p[1], code: '5' }, { ...p[2], code: '14761056' }, { ...p[3], code: '14761414' }], 'other_code'],
    ['code column shifted, the leftover code on a row without numbers', [{ ...p[0], code: null }, { ...p[1], code: '111' }, { ...p[2], code: '14761056' },
      { ...p[3], code: '14761414' }, row({ code: '444', lineNumber: 5, quantity: null, unitPriceExVat: null, lineTotalExVat: null })], 'other_code'],
    ['code column shifted, first row dropped', [{ ...p[1], code: '111' }, { ...p[2], code: '14761056' }, { ...p[3], code: '14761414' }], 'other_code'],
    // שתי שורות שהיא מספרה 2: אי אפשר לדעת איזו מהן היא השורה המודפסת.
    ['two rows numbered 2', [p[0], p[1], { ...p[2], lineNumber: 2 }, p[3]], 'line_repeated'],
    // אותו קוד בשתי שורות שלה: הקוד אינו אומר איזו שורה מודפסת קראה.
    ['the asked code on two of its rows', [p[0], p[1], { ...p[2], code: '14761056' }, p[3]], 'code_repeated'],
  ];
  for (const [label, rows, why] of variants) {
    const extra = twinRead(rows);
    assert.equal(extra.rows.find(item => item.lineNumber === 2).quantity, 7, label);
    const lit = await request([...responses(), answer(extra)], input, {}, APP_142);
    assert.equal(lit.calls.length, 4, label);
    assert.ok(lit.calls[3].input[1].content.at(-1).text.includes('שורה 2: quantity, lineTotalExVat.'), label);
    assert.equal(lit.output.consensus.escalationSelected, true, label);
    assert.deepEqual(lit.output.consensus.disputedRows, dark.output.consensus.disputedRows, label);
    assert.deepEqual(lit.output.scan, dark.output.scan, label);
    const record = lit.output.consensus.secondStrongRead;
    assert.deepEqual(record.closed, [], label);
    // C4: הקריאה הרביעית אינה זהה ל-Terra בקריאה כולה (הכרעת הבעלים הסופית; עד כאן — "not_matched" ולמה).
    assert.equal(why.length > 0, true, label);
    assert.deepEqual(record.open.map(item => [item.lineNumber, item.field, item.reason]),
      [[2, 'quantity', 'not_identical'], [2, 'lineTotalExVat', 'not_identical']], label);
    assert.equal(record.outcome, 'not_identical', label);
    assert.ok(record.differences.length > 0, label);
    // שורה 3 לא נשאלה: שתי הזולות קראו בה 6.
    assert.deepEqual(placesOf(record.notAsked), [[3, 'quantity', 'cheap_agree'], [3, 'lineTotalExVat', 'cheap_agree']], label);
  }
  // ביקורת: אותה שורה מודפסת, באותו קוד, כמו המודפס — 7 מול 6 של Terra: ההבדל הראשון הוא בשורה שנשאלה.
  const exact = await request([...responses(), answer(twinRead(twinRows()))], input, {}, APP_142);
  assert.deepEqual(exact.output.consensus.secondStrongRead.open.map(item => [item.field, item.reason]), [['quantity', 'not_identical'], ['lineTotalExVat', 'not_identical']]);
  assert.deepEqual(exact.output.consensus.secondStrongRead.differences[0], { noteIndex: 0, scope: 'row', rowIndex: 1, lineNumber: 2, field: 'quantity', values: [6, 7] });
  // ו-Terra#2 שחוזרת על ההחלפה של Terra בכל התעודה: זה הסיכון שהבעלים קיבל — שתי קריאות חזקות שטועות אותו
  // דבר בשדה שהזולות באמת נחלקו עליו. השורה שנשאלה נסגרת; שורה 3 (שתי הזולות קראו 6) נשארת לעובד.
  const repeated = await request([...responses(), answer(swapped)], input, {}, APP_142);
  assert.deepEqual(repeated.output.consensus.secondStrongRead.closed.map(item => [item.lineNumber, item.field, item.value]), [[2, 'quantity', 6], [2, 'lineTotalExVat', 20.82]]);
  assert.deepEqual(repeated.output.consensus.disputedRows.map(item => [item.lineNumber, item.fields.map(field => field.field)]), [[3, ['quantity', 'lineTotalExVat']]]);
});

test('v19: when the selected row cannot be matched to one printed line — a code printed twice, no code, no line number — no second strong read is bought', async () => {
  // הזולות נחלקו על שורה 2 (8 ו-9), ו-Terra (וגם קריאה רביעית, אילו נקנתה) קרא את הנייר בדיוק.
  const cases = [
    // אותו מוצר מודפס בשתי שורות.
    ['code_repeated', twinRows(['222', '222']), rows => rows],
    // הקוד בשורה 2 לא נקרא — ב-Terra ובקריאה הזולה הראשונה (ולכן הוא "מאושר" שם).
    ['no_code', twinRows([null, '14761414']), (rows, index) => index === 1 ? rows.map(item => item.lineNumber === 2 ? { ...item, code: '14761056' } : item) : rows],
    // Terra לא קרא את מספר השורה.
    ['no_line_number', twinRows().map(item => item.lineNumber === 2 ? { ...item, lineNumber: null } : item), () => twinRows()],
  ];
  for (const [why, terraRows, cheapRows] of cases) {
    const cheap = (quantity, index) => twinRead(twinQuantity(quantity, 2, cheapRows(terraRows.map(item => ({ ...item, lineNumber: item.lineNumber ?? 2 })), index)));
    const terra = twinRead(terraRows);
    assert.equal(tnuvaPaperCheck(terra, 1).receivable, true, why);
    const responses = () => [answer(cheap(8, 0)), answer(cheap(9, 1)), answer(terra)];
    const dark = await request(responses(), input, SECOND_OFF, APP_142);
    const lit = await request([...responses(), answer(terra)], input, {}, APP_142);
    assert.ok(dark.output.consensus.disputedRows.some(item => item.fields.some(field => field.field === 'quantity' && field.confirmed === 0)), why);
    assert.equal(lit.calls.length, 3, why + ': nothing a second strong read could settle');
    assert.deepEqual(lit.calls, dark.calls, why);
    assert.deepEqual(comparable(lit.output), comparable(dark.output), why);
    const record = lit.output.consensus.secondStrongRead;
    assert.deepEqual([record.outcome, record.asked, record.closed, record.open], ['not_matchable', 0, [], []], why);
    assert.deepEqual(record.notAsked.map(item => [item.lineNumber, item.field, item.reason, item.unmatched]),
      [[2, 'quantity', 'not_matchable', why], [2, 'lineTotalExVat', 'not_matchable', why]], why);
  }
});

test('v19 with three cheap reads: every completed cheap read must read the asked line, and no two of them alike', async () => {
  const THREE = { OPENAI_CONSENSUS_READS: '3' };
  const cheap = quantity => twinRead(twinQuantity(quantity));
  // Terra העביר יחידה בין התאומים: 8 ו-5. בשורה 3 כל הזולות קראו 6.
  const terra = twinRead(twinQuantity(5, 3, twinQuantity(8, 2)));
  // שתי זולות קראו בשורה 2 את 7 (המודפס), השלישית 9: זה שלב 1 (שתיים מסכימות), לא שלב 3.
  const agree = () => [answer(cheap(7)), answer(cheap(9)), answer(cheap(7)), answer(terra)];
  const dark = await request(agree(), input, { ...THREE, ...SECOND_OFF }, APP_142);
  const lit = await request([...agree(), answer(terra)], input, THREE, APP_142);
  assert.equal(lit.output.consensus.escalationSelected, true);
  assert.equal(lit.calls.length, 4, 'three cheap reads and the escalation, nothing more');
  assert.deepEqual(lit.calls, dark.calls);
  assert.deepEqual(comparable(lit.output), comparable(dark.output));
  const record = lit.output.consensus.secondStrongRead;
  assert.equal(record.outcome, 'not_needed');
  assert.deepEqual(record.notAsked.map(item => [item.lineNumber, item.field, item.reason, item.reads.map(read => read.value)]), [
    [2, 'quantity', 'cheap_agree', [8, 7, 9, 7]], [2, 'lineTotalExVat', 'cheap_agree', [27.76, 24.29, 31.23, 24.29]],
    [3, 'quantity', 'cheap_agree', [5, 6, 6, 6]], [3, 'lineTotalExVat', 'cheap_agree', [17.35, 20.82, 20.82, 20.82]]]);
  // שלוש קריאות שונות (7, 9 ו-10): נשאל, ו-Terra#2 שקרא 8 סוגר.
  const spread = await request([answer(cheap(7)), answer(cheap(9)), answer(cheap(10)), answer(terra), answer(terra)], input, THREE, APP_142);
  assert.equal(spread.calls.length, 5);
  assert.deepEqual(spread.output.consensus.secondStrongRead.closed.map(item => [item.lineNumber, item.field, item.reads.map(read => read.value)]), [
    [2, 'quantity', [8, 7, 9, 10, 8]], [2, 'lineTotalExVat', [27.76, 24.29, 31.23, 34.7, 27.76]]]);
  // זולה שלישית שנכשלה אינה עד: שתי הזולות שהושלמו קראו את השורה, ונחלקו (7 ו-9) — נשאל ונסגר.
  const failed = await request([answer(cheap(7)), answer(cheap(9)), { output_text: 'invalid json' }, answer(terra), answer(terra)], input, THREE, APP_142);
  assert.equal(failed.output.consensus.reason, 'read_failed');
  assert.equal(failed.calls.length, 5);
  assert.deepEqual(failed.output.consensus.secondStrongRead.closed.map(item => [item.field, item.reads.map(read => read.value)]), [
    ['quantity', [8, 7, 9, 8]], ['lineTotalExVat', [27.76, 24.29, 31.23, 27.76]]]);
  // זולה שלישית שקראה בשורה 2 קוד אחר לא קראה את השורה המודפסת הזאת — אבל ייתכן שקראה את 7 או את 9
  // במקום אחר. השדה אינו נשאל, והקוד שבמחלוקת נשאר בדיוק כמו בשירות 18.
  const otherCode = twinRead(twinQuantity(10).map(item => item.lineNumber === 2 ? { ...item, code: '5' } : item));
  const thirdResponses = () => [answer(cheap(7)), answer(cheap(9)), answer(otherCode), answer(terra)];
  const thirdDark = await request(thirdResponses(), input, { ...THREE, ...SECOND_OFF }, APP_142);
  const third = await request([...thirdResponses(), answer(terra)], input, THREE, APP_142);
  assert.equal(third.calls.length, 4);
  assert.deepEqual(comparable(third.output), comparable(thirdDark.output));
  const thirdRecord = third.output.consensus.secondStrongRead;
  assert.deepEqual(thirdRecord.notAsked.filter(item => item.lineNumber === 2).map(item => [item.field, item.reason,
    item.reads.map(read => read.seen === false ? read.unmatched : read.value)]), [
    ['quantity', 'lone', [8, 7, 9, 'other_code']], ['lineTotalExVat', 'lone', [27.76, 24.29, 31.23, 'other_code']]]);
  assert.deepEqual(third.output.consensus.disputedRows.filter(item => item.lineNumber === 2).map(item => item.fields.map(field => [field.field, field.confirmed])),
    [[['code', 2], ['quantity', 0], ['lineTotalExVat', 0]]]);
});

// מהכרעת הבעלים הסופית: זיכוי, מינוס, החזרות ופיקדון בקריאה של Terra#2 הם הבדלים בקריאה כולה — בסוג התעודה,
// בסיכום, במספר השורות ובסוג השורה — ולכן שום דבר אינו נסגר. (עד כאן — not_eligible לקול של השורה.)
test('v19 C2 on the second strong read too: a vote from a read that saw a credit note, a minus, returns or a deposit row does not count', async () => {
  const credit = item => doc({ ...item, docType: 'credit', subtotalExVat: -91, vatAmount: -16.38, totalInclVat: -107.38 });
  const minus = item => doc({ ...item, subtotalExVat: -91 });
  const withReturns = item => doc({ ...item, rows: [...item.rows, row({ section: 'returns', lineNumber: 5, quantity: 2, lineTotalExVat: 10 })] });
  const asDeposit = item => doc({ ...item, rows: item.rows.map((each, index) => index === 1 ? { ...each, description: 'פיקדון בקבוק' } : each) });
  const dark = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper)], input, SECOND_OFF);
  for (const [kind, first] of [[credit, ['docType', ['invoice', 'credit']]], [minus, ['subtotalExVat', [91, -91]]],
    [withReturns, ['rowCount', [4, 5]]], [asDeposit, ['deposit', [false, true]]]]) {
    // היא קראה בשורה 2 בדיוק את מה ש-Terra קרא (6 ו-30), אבל לא כשורת פריטים רגילה של קליטה.
    const lit = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(kind(fourRowPaper))]);
    assert.equal(lit.calls.length, 4, kind.name);
    const record = lit.output.consensus.secondStrongRead;
    assert.deepEqual(record.closed, [], kind.name);
    assert.deepEqual(record.open.map(item => [item.field, item.reason]), [['quantity', 'not_identical'], ['lineTotalExVat', 'not_identical']], kind.name);
    assert.deepEqual([record.differences[0].field, record.differences[0].values], first, kind.name);
    assert.deepEqual(lit.output.scan, dark.output.scan, kind.name);
    assert.deepEqual(lit.output.consensus.disputedRows, dark.output.consensus.disputedRows, kind.name);
  }
});

// ===== v19, מהביקורת (סבב רביעי): מספר השורה אינו מודפס — הטבלה כולה צריכה להתיישר =====
// בנייר של תנובה מספרי השורות אינם מודפסים: lineNumber הוא הספירה של הקריאה עצמה. קריאה ששמרה את
// עמודת הקוד שלמה, אבל הכמות, המחיר והסכום שלה זזו שורה אחת (כשמספרי השורות הולכים אחרי הקודים),
// נושאת בשורה 2 את הקוד של שורה 2 ואת המספרים של שורה 3 — והכלל של השורה לבדו (שורה אחת באותו עמוד
// ובאותו מספר, אותו קוד, קוד שמופיע פעם אחת) מתאים אותה. ההסטה נראית רק בטבלה כולה: שורה עודפת או
// חסרה, שורה בלי מספרים, קוד של שורה אחרת, או מחיר של שורה שכנה. הנייר: twinRows — 98.11 ₪, ובשורות
// 2 ו-3 שני תאומים ב-3.47 (7 ו-6).
const emptyNumbers = item => ({ ...item, quantity: null, unitPriceExVat: null, lineTotalExVat: null });
// המספרים של שורה 2 אבדו וכל מה שאחריהם עלה שורה, תחת קודים שלמים: בשורה 2 — 6 × 3.47 של שורה 3,
// ובשורה 3 — 1 × 3 של שורה 4.
const slidUp = () => { const p = twinRows(); return [p[0], { ...p[1], quantity: 6, lineTotalExVat: 20.82 }, { ...p[2], quantity: 1, unitPriceExVat: 3, lineTotalExVat: 3 }]; };

test('v19 on paper without printed line numbers: a second strong read whose numbers slid one row under a complete code column confirms nothing', async () => {
  // הזולות נחלקו על שורה 2 (8 ו-9; עם שלוש זולות גם 5). Terra החליף בין התאומים (6 ו-7): הנייר שלו
  // והחשבון של כל שורה נסגרים. הקריאה השנייה "קראה" בשורה 2 את 6 — בדיוק הטעות של Terra.
  const cheap = quantity => twinRead(twinQuantity(quantity));
  const swapped = twinRead(twinQuantity(7, 3, twinQuantity(6, 2)));
  const variants = [
    // השורה האחרונה נשארה בלי מספרים.
    ['the last row left without numbers', [...slidUp(), emptyNumbers(twinRows()[3])], 'numbers_missing'],
    // המספרים של השורה האחרונה נקראו פעמיים: מספר השורות, הקודים והחשבון של כל שורה — הכל נסגר,
    // ורק בשורה 3 המחיר הוא של שורה 4.
    ['the last numbers read twice', [...slidUp(), twinRows()[3]], 'price_differs'],
  ];
  for (const [label, rows, why] of variants) {
    const extra = twinRead(rows);
    // הכלל של השורה לבדו היה סופר אותה: שורה אחת בשורה 2, בקוד של Terra שמופיע אצלה פעם אחת, עם הערך של Terra.
    assert.deepEqual(extra.rows.filter(item => item.lineNumber === 2).map(item => [item.code, item.quantity]), [['14761056', 6]], label);
    assert.equal(extra.rows.filter(item => item.code === '14761056').length, 1, label);
    assert.equal(tnuvaPaperCheck(extra, 1).ok, false, label);
    for (const [env, cheapReads] of [[{}, [8, 9]], [{ OPENAI_CONSENSUS_READS: '3' }, [8, 9, 5]]]) {
      const tag = label + ' ' + JSON.stringify(env);
      const responses = () => [...cheapReads.map(quantity => answer(cheap(quantity))), answer(swapped)];
      const dark = await request(responses(), input, { ...env, ...SECOND_OFF }, APP_142);
      const lit = await request([...responses(), answer(extra)], input, env, APP_142);
      assert.equal(lit.calls.length, cheapReads.length + 2, tag + ': the cheap reads qualified the field, so it was asked');
      assert.ok(lit.calls.at(-1).input[1].content.at(-1).text.includes('שורה 2: quantity, lineTotalExVat.'), tag);
      assert.equal(lit.output.consensus.escalationSelected, true, tag);
      assert.deepEqual(lit.output.scan, dark.output.scan, tag);
      assert.deepEqual(lit.output.consensus.disputedRows, dark.output.consensus.disputedRows, tag);
      const record = lit.output.consensus.secondStrongRead;
      assert.deepEqual(record.closed, [], tag);
      // C4: הקריאה השנייה אינה זהה ל-Terra בקריאה כולה (עד הכרעת הבעלים הסופית — "not_matched" בגלל ${why}).
      assert.ok(why, tag);
      assert.deepEqual(record.open.map(item => [item.lineNumber, item.field, item.reason]),
        [[2, 'quantity', 'not_identical'], [2, 'lineTotalExVat', 'not_identical']], tag);
      assert.deepEqual(record.differences[0], { noteIndex: 0, scope: 'row', rowIndex: 2, lineNumber: 3, field: 'quantity', values: [7, 1] }, tag);
    }
  }
});

test('v19 on paper without printed line numbers: a cheap read whose numbers slid one row under a complete code column does not split the field — the cheap read that read the line stays alone', async () => {
  // Terra העביר יחידה בין התאומים (8 ו-5); הנייר שלו נסגר. קריאה זולה 2 קראה את הנייר בדיוק (7 ו-6).
  // קריאה חזקה שנייה, אילו נקנתה, הייתה חוזרת על הטעות של Terra — ושתי קריאות חזקות היו גוברות על הזולה
  // היחידה שקראה את השורות האלה.
  const moved = twinRead(twinQuantity(5, 3, twinQuantity(8, 2)));
  const exact = twinRead(twinRows());
  const variants = [
    ['three rows', slidUp(), 'lines_differ'],
    ['four rows, the last without numbers', [...slidUp(), emptyNumbers(twinRows()[3])], 'numbers_missing'],
    ['four rows, the last numbers read twice', [...slidUp(), twinRows()[3]], 'price_differs'],
  ];
  for (const [label, rows, why] of variants) {
    const slid = twinRead(rows);
    assert.deepEqual(slid.rows.filter(item => [2, 3].includes(item.lineNumber)).map(item => [item.code, item.quantity]),
      [['14761056', 6], ['14761414', 1]], label);
    const responses = () => [answer(slid), answer(exact), answer(moved)];
    const dark = await request(responses(), input, SECOND_OFF, APP_142);
    const lit = await request([...responses(), answer(moved)], input, {}, APP_142);
    // שירות 18: אף זולה אינה מאשרת את 8 ואת 5, והשדות אצל העובד. כך גם כאן.
    assert.deepEqual(dark.output.consensus.disputedRows.filter(item => [2, 3].includes(item.lineNumber))
      .map(item => [item.lineNumber, item.fields.filter(field => field.field === 'quantity').map(field => [field.selected, field.confirmed])]),
      [[2, [[8, 0]]], [3, [[5, 0]]]], label);
    assert.equal(lit.calls.length, 3, label + ': no second strong read');
    assert.deepEqual(lit.calls, dark.calls, label);
    assert.deepEqual(comparable(lit.output), comparable(dark.output), label);
    const record = lit.output.consensus.secondStrongRead;
    assert.deepEqual([record.outcome, record.asked, record.closed, record.open], ['not_needed', 0, [], []], label);
    // C4: הזולה שהמספרים שלה זזו לא קראה את השורות המודפסות 2 ו-3; הזולה השנייה לבד.
    const slidVote = { stage: 'consensus_1', value: null, seen: false, unmatched: why };
    assert.deepEqual(record.notAsked.map(item => [item.lineNumber, item.field, item.reason, item.reads[1], item.reads[2]]), [
      [2, 'quantity', 'lone', slidVote, { stage: 'consensus_2', value: 7 }], [2, 'lineTotalExVat', 'lone', slidVote, { stage: 'consensus_2', value: 24.29 }],
      [3, 'quantity', 'lone', slidVote, { stage: 'consensus_2', value: 6 }], [3, 'lineTotalExVat', 'lone', slidVote, { stage: 'consensus_2', value: 20.82 }]], label);
  }
});

test('v19 on paper without printed line numbers: a read that carries another line\'s code on any line, even with every price alike, is not read at the asked line', async () => {
  // שלוש שורות באותו מחיר, 3.47: 7, 6 ו-4. הנייר נסגר ב-108.99 ₪.
  const trioRows = () => [row({ code: '111', lineNumber: 1 }),
    row({ code: '14761056', lineNumber: 2, quantity: 7, unitPriceExVat: 3.47, lineTotalExVat: 24.29 }),
    row({ code: '14761414', lineNumber: 3, quantity: 6, unitPriceExVat: 3.47, lineTotalExVat: 20.82 }),
    row({ code: '14761520', lineNumber: 4, quantity: 4, unitPriceExVat: 3.47, lineTotalExVat: 13.88 })];
  const trio = rows => doc({ ...paper(trioRows()), rows });
  const t = trioRows();
  const at = (item, quantity) => ({ ...item, quantity, lineTotalExVat: Math.round(quantity * 347) / 100 });
  // Terra העביר יחידה משורה 3 לשורה 4 (5 ו-5); הנייר שלו נסגר. קריאה זולה 2 קראה את הנייר בדיוק.
  const moved = trio([t[0], t[1], at(t[2], 5), at(t[3], 5)]);
  assert.equal(tnuvaPaperCheck(moved, 1).receivable, true);
  // קריאה זולה 1: המספרים של שורה 2 אבדו, והשאר עלו שורה; בסוף שורת מספרים נוספת באותו מחיר, ובשורה 2
  // נשאר הקוד של שורה 1. ארבע שורות, בכל אחת כל המספרים, וכל מחיר זהה למחיר של Terra באותה שורה — רק
  // הקוד בשורה 2 מסגיר שהטבלה זזה. בשורות 3 ו-4 היא נושאת את הקוד הנכון ואת המספרים של השורה הבאה.
  const slid = trio([t[0], at({ ...t[1], code: '111' }, 6), at(t[2], 4), at(t[3], 2)]);
  const exact = trio(trioRows());
  const responses = () => [answer(slid), answer(exact), answer(moved)];
  const dark = await request(responses(), input, SECOND_OFF, APP_142);
  const lit = await request([...responses(), answer(moved)], input, {}, APP_142);
  assert.deepEqual(dark.output.consensus.disputedRows.filter(item => [3, 4].includes(item.lineNumber))
    .map(item => [item.lineNumber, item.fields.filter(field => field.field === 'quantity').map(field => [field.selected, field.confirmed])]),
    [[3, [[5, 0]]], [4, [[5, 0]]]]);
  assert.equal(lit.calls.length, 3, 'no second strong read');
  assert.deepEqual(lit.calls, dark.calls);
  assert.deepEqual(comparable(lit.output), comparable(dark.output));
  const record = lit.output.consensus.secondStrongRead;
  assert.deepEqual([record.outcome, record.asked, record.closed, record.open], ['not_needed', 0, [], []]);
  const slidVote = { stage: 'consensus_1', value: null, seen: false, unmatched: 'code_moved' };
  assert.deepEqual(record.notAsked.filter(item => [3, 4].includes(item.lineNumber)).map(item => [item.lineNumber, item.field, item.reason, item.reads[1]]), [
    [3, 'quantity', 'lone', slidVote], [3, 'lineTotalExVat', 'lone', slidVote], [4, 'quantity', 'lone', slidVote], [4, 'lineTotalExVat', 'lone', slidVote]]);
});

test('v19: when the selected table itself cannot be lined up — another row without a unit price or without a line of its own — no second strong read is bought', async () => {
  // הזולות נחלקו על שורה 2 (8 ו-9), ו-Terra החליף בין התאומים. שורה 2 של Terra עצמה תקינה.
  const cheap = quantity => twinRead(twinQuantity(quantity));
  const swappedRows = () => twinQuantity(7, 3, twinQuantity(6, 2));
  const cases = [
    // הכמות והסכום של שורה 4 נקראו, המחיר לא: הנייר נסגר (מחיר שלא נקרא אינו סותר את החשבון).
    ['a row without a unit price', swappedRows().map(item => item.lineNumber === 4 ? { ...item, unitPriceExVat: null } : item)],
    ['a row without a line number', swappedRows().map(item => item.lineNumber === 4 ? { ...item, lineNumber: null } : item)],
    ['two other rows on one line', swappedRows().map(item => item.lineNumber === 4 ? { ...item, lineNumber: 3 } : item)],
  ];
  for (const [label, rows] of cases) {
    const terra = twinRead(rows);
    assert.equal(tnuvaPaperCheck(terra, 1).receivable, true, label);
    const responses = () => [answer(cheap(8)), answer(cheap(9)), answer(terra)];
    const dark = await request(responses(), input, SECOND_OFF, APP_142);
    const lit = await request([...responses(), answer(terra)], input, {}, APP_142);
    assert.ok(dark.output.consensus.disputedRows.some(item => item.lineNumber === 2 && item.fields.some(field => field.field === 'quantity' && field.confirmed === 0)), label);
    assert.equal(lit.calls.length, 3, label + ': nothing a second strong read could settle');
    assert.deepEqual(lit.calls, dark.calls, label);
    assert.deepEqual(comparable(lit.output), comparable(dark.output), label);
    const record = lit.output.consensus.secondStrongRead;
    assert.deepEqual([record.outcome, record.asked, record.closed, record.open], ['not_matchable', 0, [], []], label);
    assert.deepEqual(record.notAsked.filter(item => item.lineNumber === 2).map(item => [item.field, item.reason, item.unmatched]),
      [['quantity', 'not_matchable', 'table_unclear'], ['lineTotalExVat', 'not_matchable', 'table_unclear']], label);
  }
});

// ===== v19, מהביקורת (סבב חמישי): אותו נייר, ומספרים שנקראו פעמיים =====
// (1) בסריקה של כמה תעודות המסמך של כל קריאה נמצא לפי ה-noteIndex שהיא עצמה דיווחה, ומאז שירות 17 אין לנייר של
// תנובה מספר תעודה. קריאה שהחליפה בין התוויות של שתי תעודות שמדפיסות אותם מוצרים באותו סדר "קראה" את השורה מהנייר
// השני: אותו עמוד, אותה שורה, אותו קוד, וטבלה שמתיישרת. עכשיו, כשיש בסריקה יותר מתעודה אחת, המסמך של קריאה הוא
// אותו נייר רק עם אותו "סהכ חייב מעמ" מודפס (בערך מוחלט), סכום שמופיע בתעודה אחת בלבד — בקריאה שנבחרה ובשלה.
// (2) קריאה שקראה את המספרים של שורה אחת גם בשורה השכנה (כמות, מחיר וסכום זהים בשתי שורות סמוכות, כשהקריאה שנבחרה
// אינה קוראת בשתיהן בדיוק אותם מספרים) — המספרים שלה זזו שורה תחת עמודת קוד שלמה, והחסר התמלא בשורה שנקראה פעמיים.
// היא אינה נספרת באף שורה.
// תעודה בפריסה של twinRows, עם הכמויות של ארבע השורות (הסכומים והסיכום המודפס בהתאם).
const twinNote = (quantities, extra = {}) => ({ ...paper(twinRows().map((item, index) =>
  ({ ...item, quantity: quantities[index], lineTotalExVat: Math.round(quantities[index] * item.unitPriceExVat * 100) / 100 }))), ...extra });
const notes = (...documents) => ({ output_text: JSON.stringify({ documents, warnings: [] }) });
const twoNotes = [input[0], { ...input[0], noteIndex: 1 }];

test('v19 with several notes in one scan: a read counts for a note only with that note\'s printed subtotal — a read that swapped the labels of two notes reads neither', async () => {
  // תעודה 0 מדפיסה בתאומים 7 ו-6 (98.11 ₪). Terra החליף ביניהם (6 ו-7): הנייר שלו והחשבון של כל שורה נסגרים.
  const note0 = twinNote([10, 7, 6, 1]);
  // קריאה של נייר מודפס: הסיכום המודפס שלו, והשורות כפי שהקריאה ראתה אותן.
  const readOf = (printed, quantities) => ({ ...printed, rows: twinNote(quantities).rows });
  const terra0 = readOf(note0, [10, 6, 7, 1]);
  assert.equal(note0.subtotalExVat, 98.11);
  assert.equal(tnuvaPaperCheck(terra0, 1).receivable, true);
  const relabel = (item, noteIndex) => ({ ...item, noteIndex });
  // N2 / N2b: קריאה זולה 1 החזירה את תעודה 1 (9 ו-5) תחת noteIndex 0, וקריאה זולה 2 קראה את תעודה 0 בדיוק. לפי
  // הנייר המודפס רק זולה 2 קראה את תעודה 0: השדות לבד, ואין קריאה רביעית — גם כש-Terra#2 הייתה חוזרת על ההחלפה.
  const sameLayout = twinNote([12, 9, 5, 2], { noteIndex: 1 });
  const otherEnds = doc({ ...paper(twinRows().map((item, index) => index === 0 ? { ...item, code: '2222', quantity: 4, lineTotalExVat: 20 }
    : index === 1 ? { ...item, quantity: 9, lineTotalExVat: 31.23 } : index === 2 ? { ...item, quantity: 5, lineTotalExVat: 17.35 }
      : { ...item, code: '5555', quantity: 2, lineTotalExVat: 6 })), noteIndex: 1 });
  for (const [label, note1] of [['N2: the same codes and prices on both notes', sameLayout], ['N2b: other products on lines 1 and 4', otherEnds]]) {
    assert.notEqual(note1.subtotalExVat, note0.subtotalExVat, label);
    const responses = () => [notes(relabel(note1, 0), relabel(note0, 1)), notes(note0, note1), notes(terra0, note1)];
    const dark = await request(responses(), twoNotes, SECOND_OFF, APP_142);
    const lit = await request([...responses(), notes(terra0, note1)], twoNotes, {}, APP_142);
    assert.equal(lit.output.consensus.escalationSelected, true, label);
    // שירות 18: שורות 2 ו-3 של תעודה 0 אצל העובד, בלי עד שמאשר.
    assert.deepEqual(dark.output.consensus.disputedRows.filter(item => item.noteIndex === 0 && [2, 3].includes(item.lineNumber))
      .map(item => [item.lineNumber, item.fields.map(field => [field.field, field.confirmed])]),
      [[2, [['quantity', 0], ['lineTotalExVat', 0]]], [3, [['quantity', 0], ['lineTotalExVat', 0]]]], label);
    assert.equal(lit.calls.length, 3, label + ': no second strong read');
    assert.deepEqual(lit.calls, dark.calls, label);
    assert.deepEqual(comparable(lit.output), comparable(dark.output), label);
    const record = lit.output.consensus.secondStrongRead;
    assert.deepEqual([record.outcome, record.asked, record.closed, record.open], ['not_needed', 0, [], []], label);
    const swappedVote = { stage: 'consensus_1', value: null, seen: false, unmatched: 'other_subtotal' };
    assert.deepEqual(record.notAsked.map(item => [item.noteIndex, item.lineNumber, item.field, item.reason, item.reads[1], item.reads[2].value]), [
      [0, 2, 'quantity', 'lone', swappedVote, 7], [0, 2, 'lineTotalExVat', 'lone', swappedVote, 24.29],
      [0, 3, 'quantity', 'lone', swappedVote, 6], [0, 3, 'lineTotalExVat', 'lone', swappedVote, 20.82]], label);
  }
  // N1: הזולות נחלקו על שורה 2 של תעודה 0 (8 ו-9), ו-Terra#2 קראה כל מספר נכון — אבל החזירה את תעודה 1, שמדפיסה בתאומים
  // 6 ו-7, תחת noteIndex 0. ה-6 שלה אינו קריאה של שורה 2 בתעודה 0, ואינו מאשר את ה-6 השגוי של Terra.
  const mirror = twinNote([12, 6, 7, 2], { noteIndex: 1 });
  const responses = () => [notes(readOf(note0, [10, 8, 6, 1]), mirror), notes(readOf(note0, [10, 9, 6, 1]), mirror), notes(terra0, mirror)];
  const dark = await request(responses(), twoNotes, SECOND_OFF, APP_142);
  const lit = await request([...responses(), notes(relabel(mirror, 0), relabel(note0, 1))], twoNotes, {}, APP_142);
  assert.equal(lit.calls.length, 4, 'the cheap reads split on note 0, line 2: asked');
  assert.ok(lit.calls[3].input[1].content.at(-1).text.includes('מסמך noteIndex=0, עמוד 1, שורה 2: quantity, lineTotalExVat.'));
  assert.deepEqual(lit.output.scan, dark.output.scan);
  assert.deepEqual(lit.output.consensus.disputedRows, dark.output.consensus.disputedRows);
  const record = lit.output.consensus.secondStrongRead;
  assert.deepEqual(record.closed, []);
  // מהכרעת הבעלים הסופית: התעודות שלה אינן זהות לאלה של Terra (עד כאן — not_matched, other_subtotal).
  assert.deepEqual(record.open.map(item => [item.noteIndex, item.lineNumber, item.field, item.reason]),
    [[0, 2, 'quantity', 'not_identical'], [0, 2, 'lineTotalExVat', 'not_identical']]);
  assert.deepEqual(record.differences[0], { noteIndex: 0, scope: 'document', field: 'subtotalExVat', values: [98.11, mirror.subtotalExVat] });
  // אותה Terra#2 עם התוויות במקומן: היא קוראת בשורה 2 את 7 המודפס — הבדל בשורה שנשאלה.
  const straight = await request([...responses(), notes(note0, mirror)], twoNotes, {}, APP_142);
  assert.deepEqual(straight.output.consensus.secondStrongRead.open.map(item => [item.field, item.reason]), [['quantity', 'not_identical'], ['lineTotalExVat', 'not_identical']]);
  assert.deepEqual(straight.output.consensus.secondStrongRead.differences[0], { noteIndex: 0, scope: 'row', rowIndex: 1, lineNumber: 2, field: 'quantity', values: [6, 7] });
  // ואם היא קראה את שתי התעודות כמו Terra — הקריאה כולה זהה, והשדות נסגרים, כמו בתעודה אחת.
  const agrees = await request([...responses(), notes(terra0, mirror)], twoNotes, {}, APP_142);
  assert.deepEqual(agrees.output.consensus.secondStrongRead.closed.map(item => [item.noteIndex, item.lineNumber, item.field, item.value]),
    [[0, 2, 'quantity', 6], [0, 2, 'lineTotalExVat', 20.82]]);
  // מינוס בסיכום: הבדל בקריאה כולה (עד כאן — not_eligible לפי C2 על הקול).
  const minus = await request([...responses(), notes({ ...terra0, subtotalExVat: -98.11 }, mirror)], twoNotes, {}, APP_142);
  assert.deepEqual(minus.output.consensus.secondStrongRead.closed, []);
  assert.deepEqual(minus.output.consensus.secondStrongRead.differences[0], { noteIndex: 0, scope: 'document', field: 'subtotalExVat', values: [98.11, -98.11] });
  // קריאה ששתי התעודות שלה נושאות אותו סכום: הסכום של תעודה 1 שונה מזה של Terra (עד כאן — subtotal_repeated).
  const twice = await request([...responses(), notes(terra0, { ...mirror, subtotalExVat: 98.11 })], twoNotes, {}, APP_142);
  assert.deepEqual(twice.output.consensus.secondStrongRead.closed, []);
  assert.deepEqual(twice.output.consensus.secondStrongRead.differences, [{ noteIndex: 1, scope: 'document', field: 'subtotalExVat', values: [mirror.subtotalExVat, 98.11] }]);
  const cheapTwice = await request([notes(readOf(note0, [10, 8, 6, 1]), { ...mirror, subtotalExVat: 98.11 }), notes(readOf(note0, [10, 9, 6, 1]), mirror), notes(terra0, mirror), notes(terra0, mirror)],
    twoNotes, {}, APP_142);
  assert.equal(cheapTwice.calls.length, 3);
  assert.deepEqual(placesOf(cheapTwice.output.consensus.secondStrongRead.notAsked.filter(item => item.lineNumber === 2)), [[2, 'quantity', 'lone'], [2, 'lineTotalExVat', 'lone']]);
  assert.equal(cheapTwice.output.consensus.secondStrongRead.notAsked[0].reads[1].unmatched, 'subtotal_repeated');
  // שתי תעודות שמדפיסות אותו סכום בקריאה שנבחרה: אף קריאה אינה ניתנת לייחוס לאחת מהן, ולא נקנית קריאה רביעית.
  const equalSum = doc({ noteIndex: 1, itemsPrintedLines: 1, subtotalExVat: 98.11, vatAmount: 17.66, totalInclVat: 115.77,
    rows: [row({ code: '2222', quantity: 1, unitPriceExVat: 98.11, lineTotalExVat: 98.11 })] });
  const sameSum = () => [notes(readOf(note0, [10, 8, 6, 1]), equalSum), notes(readOf(note0, [10, 9, 6, 1]), equalSum), notes(terra0, equalSum)];
  const sameDark = await request(sameSum(), twoNotes, SECOND_OFF, APP_142);
  const sameLit = await request([...sameSum(), notes(terra0, equalSum)], twoNotes, {}, APP_142);
  assert.equal(sameLit.calls.length, 3);
  assert.deepEqual(comparable(sameLit.output), comparable(sameDark.output));
  const sameRecord = sameLit.output.consensus.secondStrongRead;
  assert.equal(sameRecord.outcome, 'not_matchable');
  assert.deepEqual(sameRecord.notAsked.filter(item => item.lineNumber === 2).map(item => [item.field, item.reason, item.unmatched]),
    [['quantity', 'not_matchable', 'subtotal_repeated'], ['lineTotalExVat', 'not_matchable', 'subtotal_repeated']]);
  // בתעודה אחת: עד הכרעת הבעלים הסופית הסכום לא נבדק בקריאה הרביעית, וקריאה שטעתה בו סגרה את השדות. עכשיו
  // "סהכ חייב מעמ" הוא אחד משדות הסיכום שהקריאה כולה מושווית בהם — ושום דבר אינו נסגר.
  const single = await request([answer(lunaThirteen), answer(lunaSeventeen), answer(fourRowPaper), answer(doc({ ...fourRowPaper, subtotalExVat: 92 }))]);
  assert.deepEqual(single.output.consensus.secondStrongRead.closed, []);
  assert.deepEqual(single.output.consensus.secondStrongRead.differences, [{ noteIndex: 0, scope: 'document', field: 'subtotalExVat', values: [91, 92] }]);
});

test('v19 on paper without printed line numbers: a read that has a neighbouring line\'s numbers twice, where the selected read does not have those numbers on both lines, is not read at any line', async () => {
  const cheap = quantity => twinRead(twinQuantity(quantity));
  const p = twinRows();
  // N3: הזולות נחלקו על שורה 2 (8 ו-9) וקראו את שורה 3 כמו המודפס (6). Terra החליף בין התאומים (6 ו-7). Terra#2 קראה את
  // המספרים של שורה 3 גם בשורה 2 (6 ו-6): הקודים שלמים, אותו מספר שורות, מספרים ומחיר זהה בכל שורה — רק שתי שורות
  // סמוכות זהות, כשאצל Terra הן שונות, מסגירות שהמספרים זזו.
  const swapped = twinRead(twinQuantity(7, 3, twinQuantity(6, 2)));
  const twice = twinRead([p[0], { ...p[1], quantity: 6, lineTotalExVat: 20.82 }, p[2], p[3]]);
  assert.equal(tnuvaPaperCheck(twice, 1).ok, false);
  const dark = await request([answer(cheap(8)), answer(cheap(9)), answer(swapped)], input, SECOND_OFF, APP_142);
  const lit = await request([answer(cheap(8)), answer(cheap(9)), answer(swapped), answer(twice)], input, {}, APP_142);
  assert.equal(lit.calls.length, 4);
  assert.deepEqual(lit.output.consensus.disputedRows, dark.output.consensus.disputedRows);
  const record = lit.output.consensus.secondStrongRead;
  assert.deepEqual(record.closed, []);
  // מהכרעת הבעלים הסופית: בשורה 3 היא קראה 6 ו-Terra קרא 7 — הבדל בקריאה כולה (עד כאן — numbers_repeated).
  assert.deepEqual(record.open.map(item => [item.lineNumber, item.field, item.reason]),
    [[2, 'quantity', 'not_identical'], [2, 'lineTotalExVat', 'not_identical']]);
  assert.deepEqual(record.differences[0], { noteIndex: 0, scope: 'row', rowIndex: 2, lineNumber: 3, field: 'quantity', values: [7, 6] });
  // N4 / N5: הצד הזול. Terra העביר יחידה בין התאומים (8 ו-5), ו-Terra#2 (אילו נקנתה) הייתה חוזרת על כך. קריאה זולה אחת
  // קראה את הנייר בדיוק (7 ו-6), ואחרת קראה את 6 של שורה 3 גם בשורה 2: היא לא קראה את שורה 2, והשדה לבד.
  const moved = twinRead(twinQuantity(5, 3, twinQuantity(8, 2)));
  for (const [env, reads, slidIndex] of [[{}, [twice, cheap(7)], 0], [{ OPENAI_CONSENSUS_READS: '3' }, [cheap(9), cheap(7), twice], 2]]) {
    const label = JSON.stringify(env);
    const responses = () => [...reads.map(answer), answer(moved)];
    const cheapDark = await request(responses(), input, { ...env, ...SECOND_OFF }, APP_142);
    const cheapLit = await request([...responses(), answer(moved)], input, env, APP_142);
    assert.equal(cheapLit.calls.length, reads.length + 1, label + ': no second strong read');
    assert.deepEqual(cheapLit.calls, cheapDark.calls, label);
    assert.deepEqual(comparable(cheapLit.output), comparable(cheapDark.output), label);
    const cheapRecord = cheapLit.output.consensus.secondStrongRead;
    assert.deepEqual([cheapRecord.outcome, cheapRecord.asked], ['not_needed', 0], label);
    const slidVote = { stage: 'consensus_' + (slidIndex + 1), value: null, seen: false, unmatched: 'numbers_repeated' };
    assert.deepEqual(cheapRecord.notAsked.filter(item => item.lineNumber === 2).map(item => [item.field, item.reason, item.reads[slidIndex + 1]]),
      [['quantity', 'lone', slidVote], ['lineTotalExVat', 'lone', slidVote]], label);
  }
  // N6: מחירים שונים. מודפס: שורה 2 — 4 × 5.00 = 20.00, שורה 3 — 6 × 2.50 = 15.00. Terra קרא בשורה 2 8 × 2.50 = 20.00 (הנייר
  // והשורה נסגרים), הזולות קראו מחיר 5.00 ו-5.50, ולכן מחיר היחידה נשאל. Terra#2 קראה את המספרים של שורה 3 גם בשורה 2.
  // price_differs משווה ל-Terra, שלקח בעצמו את המחיר של השורה השכנה — רק המספרים שנקראו פעמיים מסגירים את זה.
  const priced = ([q2, u2], [q3, u3] = [6, 2.5]) => [p[0], { ...p[1], quantity: q2, unitPriceExVat: u2, lineTotalExVat: Math.round(q2 * u2 * 100) / 100 },
    { ...p[2], quantity: q3, unitPriceExVat: u3, lineTotalExVat: Math.round(q3 * u3 * 100) / 100 }, p[3]];
  const pricePaper = paper(priced([4, 5]));
  const priceRead = rows => doc({ ...pricePaper, rows });
  const terra = priceRead(priced([8, 2.5]));
  assert.equal(tnuvaPaperCheck(terra, 1).receivable, true);
  const priceResponses = () => [answer(priceRead(priced([4, 5]))), answer(priceRead(priced([4, 5.5]))), answer(terra)];
  const priceDark = await request(priceResponses(), input, SECOND_OFF, APP_142);
  const priceLit = await request([...priceResponses(), answer(priceRead(priced([6, 2.5])))], input, {}, APP_142);
  assert.equal(priceLit.calls.length, 4);
  assert.ok(priceLit.calls[3].input[1].content.at(-1).text.includes('שורה 2: unitPriceExVat.'));
  assert.deepEqual(priceLit.output.consensus.disputedRows, priceDark.output.consensus.disputedRows);
  const priceRecord = priceLit.output.consensus.secondStrongRead;
  assert.deepEqual(priceRecord.closed, []);
  // מהכרעת הבעלים הסופית: הכמות בשורה 2 (6 מול 8 של Terra) כבר אינה זהה (עד כאן — numbers_repeated).
  assert.deepEqual(priceRecord.open.map(item => [item.lineNumber, item.field, item.reason]), [[2, 'unitPriceExVat', 'not_identical']]);
  assert.deepEqual(priceRecord.differences[0], { noteIndex: 0, scope: 'row', rowIndex: 1, lineNumber: 2, field: 'quantity', values: [8, 6] });
  // שתי שורות זהות גם אצל Terra אינן מספיקות כשהן זהות במספרים אחרים. מודפס: 8 ו-6 בתאומים; Terra העביר יחידה (7 ו-7),
  // וקריאה זולה קראה את 6 של שורה 3 גם בשורה 2 (6 ו-6). ה-7 של Terra אינו מאשר את ה-6 שלה — הזולה השנייה (8) לבד.
  const eightSix = paper(twinQuantity(8));
  const onEightSix = rows => doc({ ...eightSix, rows });
  const sevens = onEightSix(twinQuantity(7, 3, twinQuantity(7, 2)));
  assert.equal(tnuvaPaperCheck(sevens, 1).receivable, true);
  const sixes = () => [answer(onEightSix(twinQuantity(6, 2))), answer(eightSix), answer(sevens)];
  const sixesDark = await request(sixes(), input, SECOND_OFF, APP_142);
  const sixesLit = await request([...sixes(), answer(sevens)], input, {}, APP_142);
  assert.equal(sixesLit.calls.length, 3, 'no second strong read');
  assert.deepEqual(comparable(sixesLit.output), comparable(sixesDark.output));
  assert.deepEqual(sixesLit.output.consensus.secondStrongRead.notAsked.filter(item => item.lineNumber === 2).map(item => [item.field, item.reason, item.reads[1], item.reads[2].value]), [
    ['quantity', 'lone', { stage: 'consensus_1', value: null, seen: false, unmatched: 'numbers_repeated' }, 8],
    ['lineTotalExVat', 'lone', { stage: 'consensus_1', value: null, seen: false, unmatched: 'numbers_repeated' }, 27.76]]);
  // נייר שמדפיס באמת אותם מספרים בשתי שורות סמוכות, וקריאה שנבחרה שקראה אותן כך: זה אינו סימן להסטה, והשדה נסגר.
  const pairRows = () => fourRows().map(item => item.lineNumber === 4 ? { ...item, quantity: 2, unitPriceExVat: 4, lineTotalExVat: 8 } : item);
  const pairPaper = paper(pairRows());
  const pairRead = changes => doc({ ...pairPaper, rows: pairRows().map(item => item.lineNumber === 2 ? { ...item, ...changes } : item) });
  const pair = await request([answer(pairRead({ quantity: 13, lineTotalExVat: 65 })), answer(pairRead({ quantity: 17, lineTotalExVat: 85 })), answer(pairPaper), answer(pairPaper)]);
  assert.deepEqual(pair.output.consensus.secondStrongRead.closed.map(item => [item.lineNumber, item.field]), [[2, 'quantity'], [2, 'lineTotalExVat']]);
  assert.deepEqual(pair.output.consensus.disputedRows, []);
});

// ===== v19, מהביקורת (סבב שלישי): הפאזר של הביקורת =====
// אותן תשובות של המודל, המתג דלוק וכבוי, ולכל שדה שנשאל — בדיקה מול האמת: כל שורה מודפסת נושאת
// תג (p#n בתיאור) שעובר איתה בכל טעות של הקריאה — שורה שהושמטה, הוכפלה, פוצלה, הוזזה או שהקוד שלה
// הוסט — ולכן ידוע איזו שורה מודפסת כל קריאה קראה באמת. התשובה לכל קריאה נבחרת לפי השלב שלה (מההנחיה
// שבסוף הבקשה), לא לפי סדר. ערך שגוי שנסגר כששתי הקריאות החזקות טעו אותו דבר וכל התנאים מתקיימים
// הוא הסיכון שהבעלים קיבל, ולכן אינו נספר כאן; כל הפרה של כלל — כן.
const fuzzStageOf = call => {
  const last = call.input[1].content.at(-1);
  const text = last.type === 'input_text' ? last.text : '';
  if (call.model === 'gpt-5.6-luna') return 'cheap';
  if (text.startsWith('שתי קריאות קודמות') || text.startsWith('קריאה מקבילה של אותו צילום')) return 'escalation';
  if (text.startsWith('אזהרת סכום ביקורת')) return 'checksum_retry';
  if (text.startsWith('קריאות קודמות של אותו צילום לא אישרו')) return 'second_strong_read';
  return 'unknown';
};
async function stagedRequest(reads, documents, extraEnv, extraBody) {
  const calls = [];
  let cheapIndex = 0;
  const server = createServer({ env: { OPENAI_API_KEY: 'fixture-only', OPENAI_MODEL: 'gpt-5.6-luna',
    OPENAI_RETRY_MODEL: 'gpt-5.6-terra', OPENAI_RETRY_SERVICE_TIER: 'priority', ...extraEnv },
    logger: { info() {}, error: error => { throw error; } },
    fetchImpl: async (url, options) => {
      if (url.includes('googleapis.com')) return Response.json({ keys: [jwk] });
      const call = JSON.parse(options.body); calls.push(call);
      const stage = fuzzStageOf(call);
      const read = stage === 'cheap' ? reads.cheap[cheapIndex++] : stage === 'escalation' ? reads.escalation : reads.fourth;
      assert.ok(read !== undefined, 'no read for ' + stage);
      // מהביקורת (סבב חמישי): _n ו-_p (מאיפה באו המספרים, ואיזה נייר נקרא) הם של המבדק בלבד, ואינם מגיעים לשירות.
      return Response.json({ output_text: read === 'fail' ? 'invalid json' : JSON.stringify({ documents: read, warnings: [] }, (key, value) => key === '_n' || key === '_p' ? undefined : value),
        model: call.model, id: 'test-' + calls.length, usage: { input_tokens: 10, output_tokens: 20 } });
    } });
  const output = await sendScan(server, { documents, catalog: [], ...extraBody }).ended;
  server.close();
  return { output, calls, stages: calls.map(fuzzStageOf) };
}
function fuzzRandom(seed) {
  let s = Math.imul(seed, 2654435761) >>> 0 || 1; // זרעים סמוכים — רצפים שאינם דומים זה לזה
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let index = 0; index < 8; index += 1) next();
  return { int: (a, b) => a + Math.floor(next() * (b - a + 1)), pick: list => list[Math.floor(next() * list.length)], chance: p => next() < p };
}
const r2 = value => Math.round(value * 100) / 100;
const fuzzTag = item => { const match = /p#(\d+)/.exec(String((item && item.description) || '')); return match ? Number(match[1]) : null; };
const fuzzClone = value => JSON.parse(JSON.stringify(value));
const fuzzFix = item => { item.lineTotalExVat = r2(item.quantity * item.unitPriceExVat); };
function fuzzPaper(rows, { noteIndex = 0, docType = 'invoice', sign = 1 } = {}) {
  const items = rows.filter(item => item.section === 'items'), returns = rows.filter(item => item.section === 'returns');
  const itemsTotal = r2(items.reduce((sum, item) => sum + item.lineTotalExVat, 0)), returnsTotal = r2(returns.reduce((sum, item) => sum + item.lineTotalExVat, 0));
  const subtotal = r2((itemsTotal - returnsTotal) * sign), vat = r2(subtotal * .18);
  return doc({ noteIndex, docType, itemsPrintedLines: items.length, returnsSectionTotalExVat: returns.length ? returnsTotal : null,
    returnsPrintedLines: returns.length || null, subtotalExVat: subtotal, vatAmount: vat, totalInclVat: r2(subtotal + vat),
    rows: rows.map((item, index) => ({ ...item, lineNumber: index + 1 })) });
}
// נייר מודפס: 'plain', 'repeat' (קוד אחד בשתי שורות), 'deposit', 'mixed' (עם החזרות) או 'credit'.
function fuzzPrinted(R, kind, noteIndex = 0) {
  const rows = [];
  for (let index = 0, n = R.int(2, 6); index < n; index += 1) {
    const unit = R.pick([3.47, 3.47, 5, 4, 2.5, 12.9]), quantity = R.int(1, 12);
    rows.push(row({ code: String(1000 + index * 111 + R.int(0, 9)), description: 'p#' + index + ' מוצר', quantity, unitPriceExVat: unit, lineTotalExVat: r2(quantity * unit) }));
  }
  const n = rows.length;
  // תאומים: לעיתים קרובות שתי שורות סמוכות באותו מחיר.
  if (n >= 3 && R.chance(.7)) { const i = R.int(0, n - 2); rows[i + 1].unitPriceExVat = rows[i].unitPriceExVat; fuzzFix(rows[i + 1]); }
  if (kind === 'repeat') { const i = R.int(0, n - 2), j = R.int(i + 1, n - 1); rows[j].code = rows[i].code; rows[j].unitPriceExVat = rows[i].unitPriceExVat; fuzzFix(rows[j]); }
  if (kind === 'deposit') { const i = R.int(0, n - 1); rows[i].description = 'פיקדון p#' + i; rows[i].unitPriceExVat = .3; fuzzFix(rows[i]); }
  if (kind === 'mixed') rows.push(row({ section: 'returns', code: '9990', description: 'p#' + n + ' החזרה', quantity: 2, unitPriceExVat: 5, lineTotalExVat: 10 }));
  return fuzzPaper(rows, { noteIndex, ...(kind === 'credit' ? { docType: 'credit', sign: -1 } : {}) });
}
const fuzzSamePrice = rows => {
  const pairs = [];
  rows.forEach((a, i) => rows.forEach((b, j) => { if (i < j && a.section === 'items' && b.section === 'items' && a.unitPriceExVat === b.unitPriceExVat) pairs.push([i, j]); }));
  return pairs;
};
const FUZZ_MUTATIONS = {
  qty(R, d) { const item = R.pick(d.rows), k = R.pick([-3, -2, -1, 1, 2, 3, 4]); if (item.quantity + k < 0) return; item.quantity += k; if (R.chance(.8)) fuzzFix(item); },
  swap(R, d) { const pairs = fuzzSamePrice(d.rows); if (!pairs.length) return; const [i, j] = R.pick(pairs), a = d.rows[i], b = d.rows[j];
    [a.quantity, b.quantity] = [b.quantity, a.quantity]; [a.lineTotalExVat, b.lineTotalExVat] = [b.lineTotalExVat, a.lineTotalExVat]; },
  comp(R, d) { const pairs = fuzzSamePrice(d.rows); if (!pairs.length) return; const [i, j] = R.pick(pairs), k = R.int(1, 3); if (d.rows[j].quantity - k < 0) return;
    d.rows[i].quantity += k; d.rows[j].quantity -= k; fuzzFix(d.rows[i]); fuzzFix(d.rows[j]); },
  drop(R, d) { if (d.rows.length > 1) d.rows.splice(R.int(0, d.rows.length - 1), 1); },
  dup(R, d) { const i = R.int(0, d.rows.length - 1); d.rows.splice(i + 1, 0, fuzzClone(d.rows[i])); },
  dropDup(R, d) { if (d.rows.length < 3) return; d.rows.splice(R.int(0, d.rows.length - 2), 1); const j = R.int(0, d.rows.length - 1); d.rows.splice(j + 1, 0, fuzzClone(d.rows[j])); },
  dropAdd(R, d) { if (d.rows.length < 3) return; d.rows.splice(R.int(0, d.rows.length - 2), 1);
    d.rows.push(row({ code: String(7000 + R.int(0, 99)), description: 'phantom', quantity: R.int(1, 9), unitPriceExVat: 3.47 })); fuzzFix(d.rows.at(-1)); },
  split(R, d) { const i = R.int(0, d.rows.length - 1), item = d.rows[i]; if (item.quantity < 2) return; const q = R.int(1, item.quantity - 1);
    const a = { ...item, quantity: q }, b = { ...item, quantity: item.quantity - q }; fuzzFix(a); fuzzFix(b); d.rows.splice(i, 1, a, b); },
  codeShift(R, d) { if (d.rows.length < 2) return; const from = R.int(0, d.rows.length - 2), codes = d.rows.map(item => item.code);
    if (R.chance(.5)) { for (let i = from + 1; i < d.rows.length; i += 1) d.rows[i].code = codes[i - 1]; return; }
    for (let i = from; i < d.rows.length - 1; i += 1) d.rows[i].code = codes[i + 1]; d.rows.at(-1).code = null; },
  codeMis(R, d) { const i = R.int(0, d.rows.length - 1), others = d.rows.filter((item, j) => j !== i && item.code).map(item => item.code);
    d.rows[i].code = others.length && R.chance(.5) ? R.pick(others) : String(5000 + R.int(0, 999)); },
  codeNull(R, d) { R.pick(d.rows).code = null; },
  unitMis(R, d) { const item = R.pick(d.rows); item.unitPriceExVat = r2(item.unitPriceExVat + .5); if (R.chance(.5)) fuzzFix(item); },
  returns(R, d) { R.pick(d.rows).section = 'returns'; },
  deposit(R, d) { const item = R.pick(d.rows); item.description = 'פיקדון ' + item.description; },
  credit(R, d) { d.docType = 'credit'; for (const key of ['subtotalExVat', 'vatAmount', 'totalInclVat']) d[key] = -Math.abs(d[key]); },
  minus(R, d) { d.subtotalExVat = -Math.abs(d.subtotalExVat); },
  subtotal(R, d) { d.subtotalExVat = r2(d.subtotalExVat + 1); },
  counter(R, d) { d.itemsPrintedLines = (d.itemsPrintedLines || 0) + 1; },
  star(R, d) { const item = R.pick(d.rows); item.promoStar = !item.promoStar; },
  date(R, d) { d.docDate = '8.9.2026'; },
};
// קריאה של הנייר עם טעויות. כמו בקריאה אמיתית, מספרי השורות הם הסדר שבו היא ראתה אותן.
function fuzzMutate(R, printed, names, count) {
  const d = fuzzClone(printed);
  for (let index = 0; index < count; index += 1) FUZZ_MUTATIONS[R.pick(names)](R, d);
  d.rows.forEach((item, index) => { item.lineNumber = index + 1; });
  return d;
}
// מהביקורת (סבב רביעי): compound — שינוי במספר השורות ואחריו הסטה של עמודת הקוד לכיוון השני, כך
// שהקודים חוזרים למקומם והמספרים נשארים מוסטים (הכשל שבו מספרי השורות הולכים אחרי הקודים).
function fuzzCompound(R, base) {
  const d = fuzzClone(base);
  FUZZ_MUTATIONS[R.pick(['split', 'dup', 'drop', 'dropAdd', 'dropDup'])](R, d);
  FUZZ_MUTATIONS.codeShift(R, d);
  d.rows.forEach((item, index) => { item.lineNumber = index + 1; });
  return d;
}
function fuzzScenario(seed, cheapCount, compound = false) {
  const R = fuzzRandom(seed);
  const printed = fuzzPrinted(R, R.pick(['plain', 'plain', 'plain', 'repeat', 'repeat', 'deposit', 'mixed', 'credit']));
  const second = R.chance(.25) ? fuzzPrinted(R, 'plain', 1) : null;
  const all = Object.keys(FUZZ_MUTATIONS);
  const readOf = (names, count, secondNames = null) => [fuzzMutate(R, printed, names, count)]
    .concat(second ? [fuzzMutate(R, second, secondNames || ['qty'], secondNames ? 1 : 0)] : []);
  const compoundRead = () => [fuzzCompound(R, fuzzMutate(R, printed, ['qty', 'swap', 'comp'], R.int(0, 1)))].concat(second ? [fuzzClone(second)] : []);
  const cheapNames = R.chance(.5) ? ['qty', 'qty', 'qty', 'swap', 'comp'] : all;
  const cheap = Array.from({ length: cheapCount }, () => R.chance(.06) ? 'fail' : compound && R.chance(.3) ? compoundRead() : readOf(cheapNames, R.int(0, 3)));
  // Terra: לרוב טעות שהנייר אינו תופס (החלפה בין תאומים או העברת יחידות ביניהם).
  const escalation = R.chance(.05) ? 'fail' : readOf(R.chance(.8) ? ['swap', 'comp'] : all, R.int(0, 2), second && R.chance(.6) ? ['subtotal'] : null);
  // Terra#2 (או קריאת ההצלה): תלויה ב-Terra, בנייר, או בטעויות משלה.
  const mode = R.pick(compound ? ['same', 'same', 'paper', 'own', 'own', 'fail', 'compound', 'compound', 'sameCompound'] : ['same', 'same', 'paper', 'own', 'own', 'fail']);
  let fourth;
  if (mode === 'fail') fourth = 'fail';
  else if (mode === 'same' && escalation !== 'fail') {
    fourth = [fuzzMutate(R, escalation[0], ['drop', 'dropDup', 'dropAdd', 'codeShift', 'codeMis', 'dup', 'split', 'deposit', 'returns', 'credit'], R.chance(.5) ? 1 : 0)]
      .concat(second ? [R.chance(.5) ? fuzzClone(second) : fuzzClone(escalation[1])] : []);
  } else if (mode === 'sameCompound' && escalation !== 'fail') fourth = [fuzzCompound(R, escalation[0])].concat(second ? [fuzzClone(escalation[1])] : []);
  else if (mode === 'compound') fourth = compoundRead();
  else fourth = readOf(mode === 'paper' ? ['qty'] : all, mode === 'paper' ? 0 : R.int(1, 2), second ? (R.chance(.5) ? ['qty'] : null) : null);
  return { printed, second: Boolean(second), reads: { cheap, escalation, fourth }, body: R.chance(.6) ? APP_142 : {} };
}
// מהביקורת (סבב חמישי): הסטה של המספרים בלבד ותוויות של תעודות שהוחלפו. _n על שורה — התג של השורה המודפסת שהמספרים
// שלה (כמות, מחיר וסכום) נקראו בשורה הזאת; _p על מסמך — הנייר שממנו נקרא באמת. המבדק משווה אליהם כל קריאה שנספרה.
const fuzzProvenance = (d, paperIndex) => { d._p = paperIndex; d.rows.forEach(item => { item._n = fuzzTag(item); }); return d; };
// המספרים של רצף שורות זזים שורה אחת תחת עמודת קוד שלמה, והשורה שבקצה נקראת פעמיים. בדרך כלל רק על פני שורות באותו
// מחיר (שם שום מחיר אינו מסגיר את ההסטה); anyPrice — על פני כל שורות הפריטים.
function fuzzSlide(R, d, anyPrice) {
  const rows = d.rows, runs = [];
  for (let i = 0; i < rows.length - 1; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const block = rows.slice(i, j + 1);
      if (block.some(item => item.section !== 'items') || (!anyPrice && block.some(item => item.unitPriceExVat !== rows[i].unitPriceExVat))) break;
      runs.push([i, j]);
    }
  }
  if (!runs.length) return;
  const [i, j] = R.pick(runs), numbers = rows.map(item => ({ quantity: item.quantity, unitPriceExVat: item.unitPriceExVat, lineTotalExVat: item.lineTotalExVat, _n: item._n }));
  if (R.chance(.5)) for (let k = i; k < j; k += 1) Object.assign(rows[k], numbers[k + 1]);
  else for (let k = j; k > i; k -= 1) Object.assign(rows[k], numbers[k - 1]);
}
const fuzzSwapNotes = read => { const [a, b] = read; [a.noteIndex, b.noteIndex] = [b.noteIndex, a.noteIndex]; };
function fuzzSlideScenario(seed, cheapCount) {
  const R = fuzzRandom(seed);
  const kind = R.pick(['plain', 'plain', 'plain', 'repeat', 'repeat', 'deposit', 'mixed', 'credit']);
  const printed = fuzzProvenance(fuzzPrinted(R, kind), 0);
  // לעיתים קרובות התעודה השנייה של אותה הזמנה: אותן שורות, קודים ומחירים, בכמויות אחרות.
  const second = !R.chance(.5) ? null : kind !== 'credit' && R.chance(.7)
    ? fuzzProvenance(fuzzPaper(printed.rows.map(item => { if (item.section !== 'items') return { ...item }; const quantity = R.int(1, 12); return { ...item, quantity, lineTotalExVat: r2(quantity * item.unitPriceExVat) }; }), { noteIndex: 1 }), 1)
    : fuzzProvenance(fuzzPrinted(R, 'plain', 1), 1);
  const all = Object.keys(FUZZ_MUTATIONS);
  const readOf = (names, count, secondNames = null) => [fuzzMutate(R, printed, names, count)]
    .concat(second ? [fuzzMutate(R, second, secondNames || ['qty'], secondNames ? 1 : 0)] : []);
  const cheapNames = R.chance(.5) ? ['qty', 'qty', 'qty', 'swap', 'comp'] : all;
  const cheap = Array.from({ length: cheapCount }, () => {
    if (R.chance(.06)) return 'fail';
    const read = readOf(cheapNames, R.int(0, 3));
    if (R.chance(.25)) fuzzSlide(R, read[0], R.chance(.2));
    if (second && R.chance(.15)) fuzzSwapNotes(read);
    return read;
  });
  const escalation = R.chance(.05) ? 'fail' : readOf(R.chance(.8) ? ['swap', 'comp'] : all, R.int(0, 2), second && R.chance(.6) ? ['subtotal'] : null);
  const mode = R.pick(['same', 'same', 'paper', 'own', 'fail', 'sameSlide', 'paperSlide', 'swapPaper', 'swapSame']);
  let fourth;
  if (mode === 'fail') fourth = 'fail';
  else if (mode.startsWith('same') && escalation !== 'fail') {
    fourth = fuzzClone(escalation);
    if (mode === 'sameSlide') fuzzSlide(R, fourth[0], R.chance(.2));
    if (mode === 'swapSame' && second) fuzzSwapNotes(fourth);
  } else if (mode.startsWith('paper') || mode === 'swapPaper') {
    fourth = [fuzzClone(printed)].concat(second ? [fuzzClone(second)] : []);
    if (mode === 'paperSlide') fuzzSlide(R, fourth[0], R.chance(.2));
    if (mode === 'swapPaper' && second) fuzzSwapNotes(fourth);
  } else fourth = readOf(all, R.int(1, 2), second ? (R.chance(.5) ? ['qty'] : null) : null);
  return { printed, printedSecond: second, second: Boolean(second), reads: { cheap, escalation, fourth }, body: R.chance(.6) ? APP_142 : {}, provenance: true };
}
const FUZZ_FIELDS = ['quantity', 'unitPriceExVat', 'lineTotalExVat'];
const fuzzValue = (field, value) => value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * (field === 'quantity' ? 1000 : 100));
const fuzzDeposit = item => /פ.?קדון/.test(String((item && item.description) || ''));
// כל ההפרות בתרחיש אחד (מערך ריק — אין).
async function fuzzProblems(seed, cheapCount, stats, compound = false, slides = false) {
  const sc = slides ? fuzzSlideScenario(seed, cheapCount) : fuzzScenario(seed, cheapCount, compound);
  const documents = sc.second ? [input[0], { ...input[0], noteIndex: 1 }] : input;
  const env = { OPENAI_CONSENSUS_READS: String(cheapCount) };
  const dark = await stagedRequest(sc.reads, documents, { ...env, ...SECOND_OFF }, sc.body);
  const lit = await stagedRequest(sc.reads, documents, env, sc.body);
  const D = dark.output, L = lit.output, problems = [];
  const note = text => problems.push(seed + ': ' + text);
  if (!D.ok || !L.ok) { if (D.ok !== L.ok || D.error !== L.error) note('ok/error differ'); return problems; }
  const record = L.consensus.secondStrongRead;
  stats.runs += 1;
  // שירות 18 ועוד לכל היותר קריאה אחת, במשבצת של קריאת ההצלה.
  if (lit.calls.length > cheapCount + 2) note('more than ' + (cheapCount + 2) + ' calls');
  const before = run => run.calls.filter((call, index) => ['cheap', 'escalation'].includes(run.stages[index]));
  if (!isDeep(before(lit), before(dark))) note('the cheap reads or the escalation differ');
  // הכרעת הבעלים הסופית: כשהנייר שנבחר נכשל, המשבצת היא של קריאת ההצלה בדיוק כמו בשירות 18 — אותן בקשות, תו בתו.
  if (dark.stages.includes('checksum_retry')) {
    if (!isDeep(lit.calls, dark.calls)) note('shared slot differs');
    if (record.stage !== null || record.closed.length || record.open.length) note('the checksum retry slot voted');
  } else if (lit.calls.length !== dark.calls.length) {
    stats.bought += 1;
    if (lit.calls.length !== dark.calls.length + 1 || lit.stages.at(-1) !== 'second_strong_read') note('extra call: ' + lit.stages.join(','));
    // C3: כל מספר בהנחיה הוא מסמך, עמוד או שורה.
    const allowed = new Set(record.closed.concat(record.open).flatMap(place => [String(place.noteIndex), String(place.page), String(place.lineNumber)]));
    const leaked = (lit.calls.at(-1).input[1].content.at(-1).text.match(/\d+(\.\d+)?/g) || []).filter(value => !allowed.has(value));
    if (leaked.length) note('C3 value in note ' + leaked);
    if (!record.closed.concat(record.open).length) note('bought with nothing asked');
  }
  const darkC = comparable(D), litC = comparable(L);
  // הערכים של הקריאה שנבחרה אינם משתנים; אזהרת "אישור ידני" של שורה שנסגרה כולה יכולה רק לרדת.
  if (!isDeep(litC.scan.documents, darkC.scan.documents)) note('scan documents differ');
  for (const key of ['missingRows', 'docDateUnconfirmed', 'escalationSelected', 'agreed', 'escalated', 'unverifiedSingleRead', 'diffs']) {
    if (!isDeep(litC.consensus[key], darkC.consensus[key])) note('consensus.' + key + ' differs');
  }
  if (!isDeep(litC.paperValidation, darkC.paperValidation)) note('paperValidation differs');
  if (L.model !== D.model || L.requestId !== D.requestId) note('selected read differs');
  // disputedRows דלוק = כבוי פחות השדות שנסגרו, וכל שדה שנסגר היה מחלוקת של שירות 18 שאף עד אינו מאשר.
  const closedKeys = new Set(record.closed.map(item => item.noteIndex + ':' + item.rowIndex + ':' + item.field));
  const expected = D.consensus.disputedRows.map(entry => ({ ...entry, fields: entry.fields.filter(field => !closedKeys.has(entry.noteIndex + ':' + entry.rowIndex + ':' + field.field)) }))
    .filter(entry => entry.fields.length);
  if (!isDeep(bareRows(L.consensus.disputedRows), bareRows(expected))) note('disputedRows is not service 18 minus the closed fields');
  for (const item of record.closed) {
    const entry = D.consensus.disputedRows.find(each => each.noteIndex === item.noteIndex && each.rowIndex === item.rowIndex);
    const field = entry && entry.fields.find(each => each.field === item.field);
    if (!field || field.confirmed !== 0) note('closed a field service 18 did not leave open');
  }
  if (L.scan.warnings.some(warning => !D.scan.warnings.includes(warning))) note('added a warning');
  // מול האמת: לכל שדה שנשאל או נסגר.
  const selectedStage = L.scanAudit.attempts.find(attempt => attempt.selected).stage;
  const cheapReads = sc.reads.cheap.filter(read => read !== 'fail');
  const docOf = (read, noteIndex) => read && read !== 'fail' ? read.find(each => each.noteIndex === noteIndex) : null;
  const byTag = (d, tag) => (d ? d.rows : []).filter(each => fuzzTag(each) === tag);
  const voter = record.stage === 'second_strong_read' ? sc.reads.fourth : null;
  const places = record.closed.map(item => ({ ...item, closed: true })).concat(record.open.map(item => ({ ...item, closed: false })));
  stats.asked += places.length; stats.closed += record.closed.length;
  // הכרעת הבעלים הסופית, מול הגדרה עצמאית של "זהה": אם ורק אם הקריאה של Terra#2 כולה זהה לזו שנבחרה — כל שדה
  // שנשאל נסגר (במקרה (b) כל שדה שנשאל כבר עמד ב-C1 וב-C2 בקריאה שנבחרה, והיא אינה מתחלפת).
  if (voter && voter !== 'fail' && places.length) {
    const identical = fuzzIdentical(L.scan.documents, voter);
    if (identical && record.closed.length !== places.length) note('an identical whole read left an asked field open');
    if (!identical && record.closed.length) note('closed from a whole read that is not identical');
    if (record.outcome !== (identical ? 'identical' : 'not_identical')) note('outcome ' + record.outcome);
  }
  for (const place of places) {
    const selectedDoc = L.scan.documents.find(each => each.noteIndex === place.noteIndex), item = selectedDoc.rows[place.rowIndex];
    const tag = fuzzTag(item), truth = (place.noteIndex === 1 && sc.printedSecond ? sc.printedSecond : sc.printed).rows.find(each => fuzzTag(each) === tag);
    const cheapAt = cheapReads.map(read => byTag(docOf(read, place.noteIndex), tag));
    const value = fuzzValue(place.field, item[place.field]);
    const why = [];
    // התעודה השנייה אינה במחלוקת אלא בתרחישים של תוויות שהוחלפו (שם המבדק של הנייר שלמטה בודק אותה).
    if (place.noteIndex !== 0 && !sc.provenance) why.push('second document');
    if (selectedStage !== 'consensus_escalation') why.push('selected ' + selectedStage);
    if (!tnuvaPaperCheck(selectedDoc, 1).receivable || tnuvaRowArithmetic(item) !== true) why.push('C1');
    if (!FUZZ_FIELDS.includes(place.field) || item.section !== 'items' || fuzzDeposit(item)) why.push('C2 selected');
    if (cheapReads.some(read => tnuvaPaperCheck(docOf(read, place.noteIndex), 1).review.length)) why.push('C2 cheap document');
    if (cheapAt.some(rows => rows.some(each => each.section !== 'items' || fuzzDeposit(each)))) why.push('C2 cheap row');
    // הקריאות הזולות של השורה המודפסת הזאת (בדיוק שורה אחת בכל קריאה): לפחות שתיים, שונות זו מזו ומ-Terra.
    const cheapValues = cheapAt.filter(rows => rows.length === 1).map(rows => fuzzValue(place.field, rows[0][place.field])).filter(each => each !== null);
    if (cheapValues.length < 2) why.push('fewer than two cheap readings of the printed row');
    else if (new Set(cheapValues).size < cheapValues.length) why.push('cheap readings agree');
    if (cheapValues.includes(value)) why.push('a cheap reading confirms Terra');
    if (!(item.code && cheapAt.some(rows => rows.some(each => each.code === item.code)))) why.push('identity open');
    if (!item.code || selectedDoc.rows.filter(each => each.code === item.code).length !== 1) why.push('vote impossible');
    if (place.closed) {
      if (!(voter && voter !== 'fail' && fuzzIdentical(L.scan.documents, voter))) why.push('the voter\'s whole read is not identical');
      if (truth && fuzzValue(place.field, truth[place.field]) !== value) stats.wrong += 1;
      const last = place.reads.at(-1);
      if (!(last.stage === record.stage && fuzzValue(place.field, last.value) === value)) why.push('C4 record');
    }
    // מהביקורת (סבב חמישי): כל קריאה זולה שנספרה (כל קריאה זולה שהושלמה כשהשדה נשאל) קראה את הנייר הזה (_p), ובשורה
    // שלה, לפי הכלל של השורה (עמוד, שורה וקוד), יש את המספרים של אותה שורה מודפסת כמו בשורה שנבחרה (_n). מהכרעת
    // הבעלים הסופית זה הצד של השאלה בלבד: Terra#2 אינה נספרת לפי שורה, אלא לפי הקריאה כולה (fuzzIdentical, למעלה).
    // החריג היחיד הוא מה שה-README מתאר ("What the rules cannot see"): המספרים באו משורה שהקריאה שנבחרה קוראת בדיוק כמו את
    // השורה שנשאלה, והקריאה הזאת קראה בשתיהן בדיוק אותם מספרים — רק התג מבדיל ביניהן, ושום כלל אינו יכול לראות את זה.
    if (sc.provenance) {
      const selectedRows = docOf(sc.reads.escalation, place.noteIndex).rows, selectedRow = selectedRows[place.rowIndex];
      const sameNumbers = (a, b) => FUZZ_FIELDS.every(field => fuzzValue(field, a[field]) === fuzzValue(field, b[field]));
      const counted = (read, who) => {
        const d = docOf(read, place.noteIndex);
        const at = d ? d.rows.filter(each => each.sourcePage === item.sourcePage && each.lineNumber === item.lineNumber && each.code === item.code) : [];
        if (at.length !== 1) return why.push(who + ' counted without a row of its own at the line');
        const sources = selectedRows.filter(each => each._n === at[0]._n);
        if (d._p !== place.noteIndex) why.push(who + ' read another note');
        else if (at[0]._n !== selectedRow._n && !(sources.length && sources.every(each => sameNumbers(each, selectedRow)) && sameNumbers(at[0], selectedRow))) {
          why.push(who + ' has another line\'s numbers');
        }
      };
      cheapReads.forEach((read, index) => counted(read, 'cheap read ' + (index + 1)));
    }
    if (why.length) note((place.closed ? 'closed' : 'asked') + ' line ' + place.lineNumber + ' ' + place.field + ': ' + why.join(', '));
  }
  return problems;
}
const isDeep = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
// "זהה" של הכרעת הבעלים, כתוב כאן מחדש בלי הקוד של השירות: אותן תעודות, ובכל אחת אותו סוג תעודה (זיכוי מול השאר),
// מספר עמודים ושדות סיכום (כסף לאגורה), אותו מספר שורות, ובכל שורה לפי הסדר אותו מקטע, פיקדון או לא, קוד, כמות
// (לאלפית), מחיר יחידה וסכום שורה (לאגורה). תאריך, תיאור (מעבר לפיקדון), כוכבית, עמוד ומספר שורה — אינם נמדדים.
const FUZZ_SUMMARY = ['vatPct', 'itemsSectionTotalExVat', 'promoDiscountExVat', 'itemsPrintedLines', 'returnsSectionTotalExVat', 'returnsPrintedLines',
  'subtotalExVat', 'vatAmount', 'totalInclVat', 'roundingDiff'];
function fuzzIdentical(docsA, docsB) {
  const norm = (field, value) => value == null ? null : ['vatPct', 'itemsPrintedLines', 'returnsPrintedLines'].includes(field) ? Number(value)
    : field === 'quantity' ? fuzzValue('quantity', value) : fuzzValue('money', value);
  if (docsA.length !== docsB.length) return false;
  return docsA.every(a => {
    const b = docsB.find(each => each.noteIndex === a.noteIndex);
    if (!b || (a.docType === 'credit') !== (b.docType === 'credit') || a.pageCount !== b.pageCount) return false;
    if (FUZZ_SUMMARY.some(field => norm(field, a[field]) !== norm(field, b[field]))) return false;
    return a.rows.length === b.rows.length && a.rows.every((rowA, index) => {
      const rowB = b.rows[index];
      return rowA.section === rowB.section && fuzzDeposit(rowA) === fuzzDeposit(rowB) && (rowA.code == null ? null : String(rowA.code).trim()) === (rowB.code == null ? null : String(rowB.code).trim())
        && FUZZ_FIELDS.every(field => norm(field, rowA[field]) === norm(field, rowB[field]));
    });
  });
}
// מהביקורת (סבב רביעי): הזרעים שבהם אותו פאזר, מורחב ל-20,000 תרחישים, מצא הפרה בכלל של הסבב השלישי.
// 213551 אינו כאן: קריאה זולה איבדה את המספרים של שורה 2 תחת עמודת קוד שלמה, על פני ארבע שורות
// ב-3.47, ומילאה את החסר בשורה נוספת בסוף בקוד חדש — מה שהטבלה אינה יכולה לראות (README). השדה נשאל,
// ושום דבר לא נסגר בו.
const FUZZ_REVIEW_SEEDS = [207689, 209473, 210587, 210901, 211962, 217779];
// minClosed: הסטות מורכבות חוסמות את רוב שלב 3 — זו המטרה — ולכן שם הסף נמוך.
// מהביקורת (סבב חמישי): slides — הסטות של המספרים בלבד ותוויות של תעודות שהוחלפו, בקריאות הזולות וב-Terra#2.
for (const [cheapCount, seeds, compound, minClosed, slides] of [[2, 1200, false, 10], [3, 600, false, 10], [2, 1200, true, 10], [3, 600, true, 1],
  [2, 2000, false, 10, true], [3, 1000, false, 10, true]]) {
  test(`v19 review fuzz (${cheapCount} cheap reads${compound ? ', compound shifts' : ''}${slides ? ', numbers slid and notes swapped' : ''}): on vs off on the same model answers, and every asked or closed field against the printed truth`, async () => {
    const stats = { runs: 0, bought: 0, asked: 0, closed: 0, wrong: 0 };
    const problems = [];
    const list = Array.from({ length: seeds }, (each, index) => index + 1 + cheapCount * 100000 + (compound ? 50000 : 0) + (slides ? 70000 : 0))
      .concat(cheapCount === 2 && !compound && !slides ? FUZZ_REVIEW_SEEDS : []);
    for (const seed of list) problems.push(...await fuzzProblems(seed, cheapCount, stats, compound, slides));
    assert.deepEqual(problems.slice(0, 20), [], JSON.stringify(stats) + ' ' + problems.length + ' problems');
    // הפאזר אכן מגיע לשלב 3: שואל וסוגר.
    assert.ok(stats.asked > 20 && stats.closed >= minClosed, JSON.stringify(stats));
  });
}

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
test('/health reports service 20 and that it honours strongReadSelection', async () => {
  const { server } = scanServer([]);
  const req = Readable.from([]);
  req.method = 'GET'; req.url = '/health'; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { origin: 'https://asafkiri.github.io' };
  const response = fakeResponse();
  const ended = new Promise(resolve => { response.resolveEnd = resolve; });
  server.emit('request', req, response);
  await ended;
  const health = response.json();
  assert.equal(health.serviceVersion, 20);
  assert.equal(health.codeAgreement, true);
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
  assert.equal(output.serviceVersion, 20);
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

// ===== v20: הסכמת קריאות על קוד =====
// הכרעת הבעלים (29.10): מחלוקת על קוד נסגרת אצל הלקוח כשקריאה חזקה קראה כמו קריאה זולה, או כששתי
// הקריאות החזקות קראו אותו קוד — והקוד המוסכם במאגר במחיר המודפס. השרת מוסר מה כל קריאה קראה בשורה
// המודפסת (לפי הכסף שלה) ואת ההסכמה; קריאה חזקה שנייה נקנית לקוד רק ללקוח שביקש (codeAgreement:true),
// ורק כש-Terra לא קראה כמו אף קריאה זולה. הנייר של 29.10: הזולות נחלקו על הקוד של שורה 27 (4172329 מול
// 4127329), הזולה הראשונה נבחרה על הכסף, ו-Terra קראה כמו השנייה.
const APP_150 = { strongReadSelection: true, codeAgreement: true };
const terraThird = doc({ ...shiftedCodes, rows: [shiftedCodes.rows[0], row({ ...shiftedCodes.rows[1], code: '333' })] });
const codeField = output => output.consensus.disputedRows[0].fields.find(item => item.field === 'code');
const readsOf = output => codeField(output).reads.map(read => [read.stage, read.value, read.selected === true]);

test('v20: a strong read that read the code like one cheap read is an agreement — reported, and no fourth read is bought', async () => {
  // 29.10: הזולה הראשונה נבחרה (הנייר שלה נסגר), Terra קראה את הקוד כמו הזולה השנייה אבל את הסיכום בטעות.
  const terraLikeSecond = doc({ ...shiftedCodesOther, subtotalExVat: 79 });
  for (const extraBody of [APP_150, APP_142]) {
    const label = JSON.stringify(extraBody);
    const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(terraLikeSecond)], input, {}, extraBody);
    assert.equal(calls.length, 3, label + ': Terra agreed with a cheap read, nothing to buy');
    assert.equal(output.consensus.codeAgreement, extraBody.codeAgreement === true, label);
    assert.equal(output.consensus.escalationSelected, false, label);
    const field = codeField(output);
    assert.deepEqual(bare([field]), [{ field: 'code', selected: '222', other: '111', confirmed: 0 }], label);
    assert.deepEqual(readsOf(output), [['consensus_1', '222', true], ['consensus_2', '111', false], ['consensus_escalation', '111', false]], label);
    assert.deepEqual(field.agreement, { code: '111', kind: 'strong_cheap', stages: ['consensus_2', 'consensus_escalation'] }, label);
    // הקריאה שנבחרה עדיין מספקת את הערכים; ההסכמה אינה משכתבת את הקוד.
    assert.equal(output.scan.documents[0].rows[1].code, '222', label);
    assert.equal(output.consensus.secondStrongRead.outcome, 'not_needed', label);
    assert.deepEqual(output.consensus.secondStrongRead.notAsked.map(item => [item.lineNumber, item.field, item.reason, item.agreement && item.agreement.code]),
      extraBody.codeAgreement === true ? [[2, 'code', 'agreed', '111']] : [], label);
  }
  // אפליקציה ישנה (בלי הדגלים): ההכרעה נבחרת, והזולה הראשונה היא העדה שחולקת — אותה הסכמה, מהצד השני.
  const old = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(shiftedCodesOther)]);
  assert.equal(old.calls.length, 3);
  assert.equal(old.output.consensus.escalationSelected, true);
  assert.deepEqual(bare([codeField(old.output)]), [{ field: 'code', selected: '111', other: '222', confirmed: 1 }]);
  assert.deepEqual(readsOf(old.output), [['consensus_escalation', '111', true], ['consensus_1', '222', false], ['consensus_2', '111', false]]);
  assert.deepEqual(codeField(old.output).agreement, { code: '111', kind: 'strong_cheap', stages: ['consensus_escalation', 'consensus_2'] });
  // המתג כבוי: אין קריאה רביעית לשום דבר, אבל הדיווח נשאר — הוא מתוך הקריאות שכבר נעשו.
  const off = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(terraLikeSecond)], input, SECOND_OFF, APP_150);
  assert.equal(off.calls.length, 3);
  assert.ok(!('secondStrongRead' in off.output.consensus));
  assert.deepEqual(codeField(off.output).agreement, { code: '111', kind: 'strong_cheap', stages: ['consensus_2', 'consensus_escalation'] });
});

test('v20: when Terra read a third code, a client that asked gets one more strong read, and what it reads decides the agreement', async () => {
  const fourth = code => doc({ ...shiftedCodes, rows: [shiftedCodes.rows[0], row({ ...shiftedCodes.rows[1], code })] });
  const cases = [
    ['like the second cheap read', fourth('111'), { code: '111', kind: 'strong_cheap', stages: ['consensus_2', 'second_strong_read'] }, 'code_agreed'],
    ['like the first cheap read', fourth('222'), { code: '222', kind: 'strong_cheap', stages: ['consensus_1', 'second_strong_read'] }, 'code_agreed'],
    ['like Terra', fourth('333'), { code: '333', kind: 'strong_strong', stages: ['consensus_escalation', 'second_strong_read'] }, 'code_agreed'],
    ['a fourth value', fourth('444'), null, 'code_not_agreed'],
    ['no code at all', fourth(null), null, 'code_not_agreed']];
  for (const [label, extra, agreement, outcome] of cases) {
    const { output, calls, logs } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(terraThird), answer(extra)], input, {}, APP_150);
    assert.equal(calls.length, 4, label);
    assert.deepEqual(output.scanAudit.attempts.map(a => [a.stage, a.selected]),
      [['consensus_1', false], ['consensus_2', false], ['consensus_escalation', true], ['second_strong_read', false]], label);
    // C3: המודל החזק, אותם צילומים, ובהנחיה רק המקום ואזהרת הקוד — בלי אף ערך שנקרא.
    assert.equal(calls[3].model, 'gpt-5.6-terra', label);
    const note = calls[3].input[1].content.at(-1).text;
    assert.ok(note.includes('שורה 2: code.') && note.includes('ספרה אחר ספרה') && note.includes('באופן עצמאי'), label + ': ' + note);
    for (const value of ['111', '222', '333', '30', '80']) assert.ok(!note.includes(value), label + ' leaked ' + value);
    // הקריאה שנבחרה (Terra) מספקת את הערכים, והרביעית לעולם אינה נבחרת.
    assert.equal(output.model, 'gpt-5.6-terra', label);
    assert.equal(output.requestId, 'test-3', label);
    assert.equal(output.scan.documents[0].rows[1].code, '333', label);
    assert.equal(output.consensus.escalationSelected, true, label);
    // השדה נשאר ב-disputedRows (המאגר מכריע אצל הלקוח), עם ארבע קריאות וההסכמה.
    assert.deepEqual(bare(output.consensus.disputedRows[0].fields), [{ field: 'code', selected: '333', other: '222', confirmed: 0 }], label);
    assert.deepEqual(readsOf(output), [['consensus_escalation', '333', true], ['consensus_1', '222', false], ['consensus_2', '111', false], ['second_strong_read', extra.rows[1].code, false]], label);
    assert.deepEqual(codeField(output).agreement, agreement, label);
    // C4: הרשומה — מה נשאל, מה כל קריאה קראה ומה יצא; אותה רשומה ביומן.
    const record = output.consensus.secondStrongRead;
    // differences — מה הקריאה הרביעית קראה אחרת מ-Terra בקריאה כולה, ליומן; שום שדה כסף לא נשאל ולא נסגר.
    assert.deepEqual([record.outcome, record.stage, record.asked, record.closed, record.open], [outcome, 'second_strong_read', 1, [], []], label);
    assert.deepEqual(record.differences, scanSecondStrongWholeReadDifferences(scan(terraThird), scan(extra)), label);
    assert.deepEqual(record.codes.map(item => [item.noteIndex, item.rowIndex, item.page, item.lineNumber, item.field, item.value, item.reads.map(read => read.value), item.agreement]),
      [[0, 1, 1, 2, 'code', '333', ['333', '222', '111', extra.rows[1].code], agreement]], label);
    assert.deepEqual(output.scanAudit.secondStrongRead, record, label);
    assert.deepEqual(logs[0][1].secondStrongRead, record, label);
    assert.ok(output.scan.warnings.some(warning => warning.includes('אישור ידני')), label + ': the warning is the client\'s to lift, with the catalog');
  }
  // הקריאה הרביעית נכשלה: שום דבר לא משתנה, אין ניסיון נוסף, והשדה עם שלוש קריאות בלבד.
  const failed = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(terraThird), new Error('test network failure')], input, {}, APP_150);
  assert.equal(failed.calls.length, 4);
  assert.equal(failed.output.ok, true);
  assert.equal(failed.output.consensus.secondStrongRead.outcome, 'failed');
  assert.deepEqual(readsOf(failed.output), [['consensus_escalation', '333', true], ['consensus_1', '222', false], ['consensus_2', '111', false]]);
  assert.equal(codeField(failed.output).agreement, null);
  assert.deepEqual(failed.output.consensus.secondStrongRead.codes.map(item => [item.field, item.reads.length, item.agreement]), [['code', 3, null]]);
  // בלי הדגל — אפליקציה 142 או ישנה יותר — שום קריאה אינה נקנית לקוד, והדיווח נשאר.
  for (const extraBody of [APP_142, {}, { strongReadSelection: true, codeAgreement: 'true' }]) {
    const label = JSON.stringify(extraBody);
    const { output, calls } = await request([answer(shiftedCodes), answer(shiftedCodesOther), answer(terraThird)], input, {}, extraBody);
    assert.equal(calls.length, 3, label);
    assert.equal(output.consensus.codeAgreement, false, label);
    assert.equal(output.consensus.secondStrongRead.outcome, 'not_needed', label);
    assert.deepEqual(output.consensus.secondStrongRead.notAsked, [], label + ': the code plan does not run for a client that did not ask');
    assert.equal(readsOf(output).length, 3, label);
    assert.equal(codeField(output).agreement, null, label);
  }
});

test('v20: the fourth read shares the slot — a failed paper gives it to the checksum retry, and money fields ride the same call as the code', async () => {
  // (a) כל הקריאות קראו את הסיכום בטעות: Terra נבחרת בשוויון, הנייר נכשל, והמשבצת היא של קריאת ההצלה.
  const wrong = value => doc({ ...value, subtotalExVat: 79 });
  const slot = await request([answer(wrong(shiftedCodes)), answer(wrong(shiftedCodesOther)), answer(wrong(terraThird)), answer(wrong(terraThird))], input, {}, APP_150);
  assert.equal(slot.calls.length, 4);
  assert.deepEqual(slot.output.scanAudit.attempts.map(a => a.stage), ['consensus_1', 'consensus_2', 'consensus_escalation', 'checksum_retry']);
  assert.ok(slot.calls[3].input[1].content.at(-1).text.startsWith('אזהרת סכום ביקורת'));
  const record = slot.output.consensus.secondStrongRead;
  assert.equal(record.outcome, 'checksum_retry_slot');
  assert.deepEqual(record.notAsked.map(item => [item.lineNumber, item.field, item.reason]), [[2, 'code', 'checksum_retry_slot']]);
  assert.equal(codeField(slot.output).agreement, null);
  assert.deepEqual(readsOf(slot.output).map(read => read[0]), ['consensus_escalation', 'consensus_1', 'consensus_2']);
  // (b) שדות הכסף של שירות 19 וקוד בשורה אחרת, באותה קריאה: הכסף נסגר רק בקריאה זהה כולה (כמו ב-19),
  // והקוד — לפי ההסכמה. הזולות נחלקו על הכמות בשורה 2 וקראו בשורה 4 קודים שאינם במאגר של אף אחת.
  const codeAt = (base, code) => doc({ ...base, rows: base.rows.map((item, index) => index === 3 ? { ...item, code } : item) });
  const both = await request([answer(codeAt(lunaThirteen, '445')), answer(codeAt(lunaSeventeen, '446')), answer(fourRowPaper), answer(fourRowPaper)], input, {}, APP_150);
  assert.equal(both.calls.length, 4, 'one extra call for everything');
  const note = both.calls[3].input[1].content.at(-1).text;
  assert.ok(note.includes('שורה 2: quantity, lineTotalExVat.') && note.includes('שורה 4: code.') && note.includes('ספרה אחר ספרה'), note);
  const bothRecord = both.output.consensus.secondStrongRead;
  assert.equal(bothRecord.outcome, 'identical');
  assert.equal(bothRecord.asked, 3);
  assert.deepEqual(bothRecord.closed.map(item => [item.lineNumber, item.field]), [[2, 'quantity'], [2, 'lineTotalExVat']]);
  assert.deepEqual(bothRecord.codes.map(item => [item.lineNumber, item.agreement]), [[4, { code: '444', kind: 'strong_strong', stages: ['consensus_escalation', 'second_strong_read'] }]]);
  assert.deepEqual(both.output.consensus.disputedRows.map(item => [item.lineNumber, bare(item.fields)]), [[4, [{ field: 'code', selected: '444', other: '445', confirmed: 0 }]]]);
  assert.deepEqual(both.output.consensus.disputedRows[0].fields[0].agreement.code, '444');
  // והקריאה הרביעית שקראה את הקוד כמו Terra אבל את הכמות אחרת: הכסף פתוח (לא זהה), הקוד מוסכם.
  const split = await request([answer(codeAt(lunaThirteen, '445')), answer(codeAt(lunaSeventeen, '446')), answer(fourRowPaper), answer(rowTwo({ quantity: 9, lineTotalExVat: 45 }))], input, {}, APP_150);
  assert.equal(split.output.consensus.secondStrongRead.outcome, 'not_identical');
  assert.deepEqual(split.output.consensus.secondStrongRead.open.map(item => item.field), ['quantity', 'lineTotalExVat']);
  assert.deepEqual(split.output.consensus.secondStrongRead.codes[0].agreement, { code: '444', kind: 'strong_strong', stages: ['consensus_escalation', 'second_strong_read'] });
});

test('v20: a read counts for a code only on the printed line its money names — the rules of the anchor', () => {
  const selected = { stage: 'consensus_1', scan: scan(fourRowPaper) };
  const witness = (stage, document) => ({ stage, scan: scan(document) });
  const reads = (witnesses, rowIndex) => scanCodeReads(selected, witnesses, 0, rowIndex);
  // אותו מספר שורות: אותו מיקום ואותם מספרים.
  assert.deepEqual(reads([witness('consensus_2', atRow(3, { code: '445' }))], 3), [{ stage: 'consensus_1', value: '444', selected: true }, { stage: 'consensus_2', value: '445' }]);
  // אותו מיקום, מספרים אחרים — לא אותה שורה.
  assert.deepEqual(reads([witness('consensus_2', lunaThirteen)], 1)[1], { stage: 'consensus_2', value: null, seen: false, unmatched: 'numbers_differ' });
  // מספר שורות שונה: השורה היחידה באותם מספרים; שורה שנשמטה — לא נראתה.
  assert.deepEqual(reads([witness('consensus_2', droppedRowPaper)], 3)[1], { stage: 'consensus_2', value: '444' });
  assert.deepEqual(reads([witness('consensus_2', droppedRowPaper)], 2)[1], { stage: 'consensus_2', value: null, seen: false });
  // מספר שורות שונה ומספרים שחוזרים בשורה אחרת (שבעה יופלה ב-12 × 3.69) — אין במה לזהות את השורה.
  const twinsSelected = { stage: 'consensus_1', scan: scan(paper([row({ code: '111', lineNumber: 1 }), row({ code: '222', lineNumber: 2 }), row({ code: '333', lineNumber: 3, quantity: 1, unitPriceExVat: 3, lineTotalExVat: 3 })])) };
  const twinsOther = paper([row({ code: '111', lineNumber: 1 }), row({ code: '222', lineNumber: 2 }), row({ code: '222', lineNumber: 3 }), row({ code: '333', lineNumber: 4, quantity: 1, unitPriceExVat: 3, lineTotalExVat: 3 })]);
  assert.deepEqual(scanCodeReads(twinsSelected, [witness('consensus_2', twinsOther)], 0, 1)[1], { stage: 'consensus_2', value: null, seen: false, unmatched: 'numbers_repeated' });
  assert.deepEqual(scanCodeReads(twinsSelected, [witness('consensus_2', twinsOther)], 0, 2)[1], { stage: 'consensus_2', value: '333' });
  // שורת פריטים מול החזרה או פיקדון באותם מספרים — לא אותה שורה; שורה שנבחרה בלי מספרים — אין מה להתאים.
  assert.deepEqual(reads([witness('consensus_2', atRow(3, { section: 'returns' }))], 3)[1], { stage: 'consensus_2', value: null, seen: false, unmatched: 'other_kind' });
  assert.deepEqual(reads([witness('consensus_2', atRow(3, { description: 'פיקדון בקבוק' }))], 3)[1], { stage: 'consensus_2', value: null, seen: false, unmatched: 'other_kind' });
  const noNumbers = { stage: 'consensus_1', scan: scan(atRow(3, { quantity: null })) };
  assert.deepEqual(scanCodeReads(noNumbers, [witness('consensus_2', fourRowPaper)], 0, 3)[1], { stage: 'consensus_2', value: null, seen: false, unmatched: 'no_numbers' });
  // קריאה שלא ראתה את המסמך.
  assert.deepEqual(reads([witness('consensus_2', { documents: [], warnings: [] })], 3)[1], { stage: 'consensus_2', value: null, seen: false });
  // בסריקה של כמה תעודות — אותו נייר לפי "סהכ חייב מעמ", כמו בשירות 19.
  const twoNotes = (a, b) => ({ documents: [{ ...a, noteIndex: 0 }, { ...b, noteIndex: 1 }], warnings: [] });
  const second = doc({ noteIndex: 1, subtotalExVat: 49, rows: [row({ code: '9', quantity: 7, unitPriceExVat: 7, lineTotalExVat: 49 })] });
  const swapped = { stage: 'consensus_2', scan: twoNotes(second, fourRowPaper) };
  assert.deepEqual(scanCodeReads({ stage: 'consensus_1', scan: twoNotes(fourRowPaper, second) }, [swapped], 0, 3)[1], { stage: 'consensus_2', value: null, seen: false, unmatched: 'other_subtotal' });
  assert.deepEqual(scanCodeReads({ stage: 'consensus_1', scan: twoNotes(fourRowPaper, second) }, [{ stage: 'consensus_2', scan: twoNotes(atRow(3, { code: '445' }), second) }], 0, 3)[1], { stage: 'consensus_2', value: '445' });
});

test('v20: the agreement itself — two strong reads first, then a strong read with a cheap one, then two cheap reads; a split is no agreement', () => {
  const read = (stage, value, selected) => ({ stage, value, ...(selected ? { selected: true } : {}) });
  const cheap1 = v => read('consensus_1', v), cheap2 = v => read('consensus_2', v), terra = v => read('consensus_escalation', v), terra2 = v => read('second_strong_read', v);
  assert.deepEqual(scanCodeAgreement([cheap1('222', true), cheap2('111'), terra('111')]), { code: '111', kind: 'strong_cheap', stages: ['consensus_2', 'consensus_escalation'] });
  assert.deepEqual(scanCodeAgreement([terra('333', true), cheap1('222'), cheap2('111'), terra2('333')]), { code: '333', kind: 'strong_strong', stages: ['consensus_escalation', 'second_strong_read'] });
  // שתי חזקות שהסכימו גוברות על חזקה שמתאימה לזולה; שני זוגות חזקה-זולה על שני קודים — אין הסכמה.
  assert.deepEqual(scanCodeAgreement([terra('222', true), cheap1('222'), cheap2('111'), terra2('222')]).kind, 'strong_strong');
  assert.equal(scanCodeAgreement([terra('222', true), cheap1('222'), cheap2('111'), terra2('111')]), null);
  assert.deepEqual(scanCodeAgreement([read('checksum_retry', '9', true), cheap1('8'), cheap2('8')]), { code: '8', kind: 'cheap_cheap', stages: ['consensus_1', 'consensus_2'] });
  assert.equal(scanCodeAgreement([cheap1('222', true), cheap2('111'), terra('333')]), null);
  // קריאה שלא קראה קוד, או שלא הותאמה לשורה, אינה מצביעה; רווחים אינם הבדל.
  assert.equal(scanCodeAgreement([cheap1('222', true), cheap2(null), terra(null)]), null);
  assert.equal(scanCodeAgreement([cheap1('222', true), { stage: 'consensus_2', value: '222', seen: false }, terra('111')]), null);
  assert.deepEqual(scanCodeAgreement([cheap1(' 222 ', true), cheap2('111'), terra('222')]).code, '222');
  // בלי מודל הסלמה אין קריאה חזקה: ההסלמה היא עוד קריאה זולה.
  assert.deepEqual(scanCodeAgreement([cheap1('222', true), cheap2('111'), terra('111')], () => false).kind, 'cheap_cheap');
  // disputedRows עם reads ו-agreement — רק לשדה הקוד.
  const selected = { stage: 'consensus_1', scan: scan(shiftedCodes) };
  const decorated = scanCodeDisputes(scanConsensusDisputedRows(scan(shiftedCodes), [scan(shiftedCodesOther)]), selected, [{ stage: 'consensus_2', scan: scan(shiftedCodesOther) }]);
  assert.deepEqual(decorated, [{ noteIndex: 0, rowIndex: 1, lineNumber: 2, code: '222', description: 'חלב בדיקה', fields: [{ field: 'code', selected: '222', other: '111', confirmed: 0,
    reads: [{ stage: 'consensus_1', value: '222', selected: true }, { stage: 'consensus_2', value: '111' }], agreement: null }] }]);
  const money = scanCodeDisputes(v18Dispute, { stage: 'consensus_escalation', scan: scan(fourRowPaper) }, [{ stage: 'consensus_1', scan: scan(lunaThirteen) }]);
  assert.deepEqual(money, v18Dispute);
});

test('v20: the code plan — asked only when a strong read exists and nothing agrees yet, and never for a row without numbers', () => {
  const witnesses = [{ stage: 'consensus_2', scan: scan(shiftedCodesOther) }];
  const places = plan => plan.places.map(item => [item.lineNumber, item.field, item.value, item.reads.length]);
  const notAsked = plan => plan.notAsked.map(item => [item.lineNumber, item.field, item.reason]);
  // אין קריאה חזקה: לא נשאל.
  const cheapOnly = scanCodeAgreementPlan({ stage: 'consensus_1', scan: scan(shiftedCodes) }, witnesses, input);
  assert.deepEqual([places(cheapOnly), notAsked(cheapOnly)], [[], [[2, 'code', 'no_strong_read']]]);
  // Terra קראה קוד שלישי: נשאל, עם מה שכל קריאה קראה.
  const third = scanCodeAgreementPlan({ stage: 'consensus_escalation', scan: scan(terraThird) }, [{ stage: 'consensus_1', scan: scan(shiftedCodes) }, ...witnesses], input);
  assert.deepEqual([places(third), notAsked(third)], [[[2, 'code', '333', 3]], []]);
  // Terra הסכימה עם זולה: לא נשאל, וההסכמה מצורפת.
  const agreedPlan = scanCodeAgreementPlan({ stage: 'consensus_1', scan: scan(shiftedCodes) }, [...witnesses, { stage: 'consensus_escalation', scan: scan(shiftedCodesOther) }], input);
  assert.deepEqual(notAsked(agreedPlan), [[2, 'code', 'agreed']]);
  assert.deepEqual(agreedPlan.notAsked[0].agreement, { code: '111', kind: 'strong_cheap', stages: ['consensus_2', 'consensus_escalation'] });
  // שורה שנבחרה בלי כמות: אף קריאה אינה ניתנת להתאמה אליה, ולא קונים קריאה שאינה יכולה להיספר.
  const noQuantity = doc({ ...terraThird, rows: [terraThird.rows[0], { ...terraThird.rows[1], quantity: null }] });
  const unmatchable = scanCodeAgreementPlan({ stage: 'consensus_escalation', scan: scan(noQuantity) }, [{ stage: 'consensus_1', scan: scan(shiftedCodes) }, ...witnesses], input);
  assert.deepEqual([places(unmatchable), notAsked(unmatchable)], [[], [[2, 'code', 'not_matchable']]]);
  // בלי מודל הסלמה ההסלמה אינה חזקה — ואין מה לשאול.
  const weak = scanCodeAgreementPlan({ stage: 'consensus_escalation', scan: scan(terraThird) }, [{ stage: 'consensus_1', scan: scan(shiftedCodes) }, ...witnesses], input, { strong: () => false });
  assert.deepEqual(notAsked(weak), [[2, 'code', 'no_strong_read']]);
});
