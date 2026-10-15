# Tnuva invoice scanner — service 18

## Service 18

Service 18 changes when the paid third read happens, what it is told, and —
for a client that asks for it — what it decides. It is built on service 17
(below): there is no document number, and an unreadable header is a regular
document.

The two cheap reads escalate only on a difference in a field that feeds a
decision in the app: a row's code, quantity, unit price, line total, promotion
star and section, whether a row exists, the row count, and the document type,
page count, section totals, promotion discount, printed line counters and net
subtotal. The document type is compared as service 17 compares it — a credit
note against anything else — so `invoice` against `unknown` is no difference,
and the document number is not compared because it is not read. The document
date (the owner's decision), the page a row was assigned to, the VAT rate, the
VAT amount, the total including VAT and the rounding difference do not
escalate: the app shows them as information or a warning and computes with its
own VAT setting and the printed net. A difference in them is still returned in
`consensus.diffs`, marked `trigger: false`, and `consensus.agreed` is computed
on the other differences only — reads that differ only in the date cost one
paid call less. Together with service 17 this covers the photo whose header
was cut: under service 17 the type no longer escalated, but the date that was
usually cut with it still did; now neither does, and the date is named in
`consensus.docDateUnconfirmed` instead. A minus sign that only one read saw on
a summary amount is a money difference and still escalates.

Because a date difference no longer buys the retry model, a cheap read can be
selected with a date nobody settled. The owner's decision is that a date that
was not read well defaults to today. The app uses the printed date only as the
day prices and promotion validity are checked against, so it needs to know when
not to trust that date. `consensus.docDateUnconfirmed` lists the `noteIndex` of
every document where another read read a different date and no other read
confirms the selected date. "Another read" means the same witnesses as
`consensus.disputedRows`: every completed cheap read and the retry model's
read, except the selected one. A checksum-retry read that wins is measured
against all of them; one that loses is not a witness. Dates are compared as
calendar days, parsed the way the app's `priceAuditDate` parses them: ISO
`YYYY-MM-DD`, or day/month/year with `/`, `.` or `-` and a 2- or 4-digit year
(2-digit means 20xx). So `17/09/2026`, `17.09.2026`, `17/09/26` and
`2026-09-17` confirm each other, and so do `7.9.2026` and `07.09.2026`. Only
when one side does not parse as a real day are the trimmed strings compared.
`consensus.diffs` and the escalation rules are unchanged: there a format-only
difference is still listed, with `trigger: false`. Dates are compared directly
from the documents, not taken from `consensus.diffs`, which stops at 200
entries. A read that returned no date, or did not return that document, does
not confirm.
The array is always present. It is empty when consensus was not attempted,
when the dates agree, and for a lone read. A lone read has no witness, so
nobody read another date, and `consensus.unverifiedSingleRead` already says
that nothing is confirmed. The service still returns the printed date
unchanged and escalates, selects and warns exactly as before. The app decides
which day to use and shows the worker that the day was assumed.

The retry model reads the photo independently. Until service 17 its corrective
note quoted both earlier values ("read once X and once Y"), and a model handed
two answers picks between them instead of reading the paper. The note now names
only where the reads differed — document, page, line number and field name —
with the known column-shift failure and the instruction to match the printed
`פריטים` counter. A credit note against a regular document is named as the
field `docType`, never as the two readings. The checksum-retry note (computed
against printed totals) is unchanged.

The retry model no longer wins because it is expensive — when the client says
it understands that. App 142 sends `"strongReadSelection": true` in the body of
every request that starts a scan. For such a scan, after a successful
escalation the server selects, among the cheap reads that completed and the
retry model's read, the one with the smallest paper error, and a tie goes to
the retry model. Without the flag — any app up to 141, or any value other than
the JSON `true` — a completed escalation is the read returned, exactly as in
services 16 and 17, and no paper error is recorded. `consensus.strongReadSelection`
says which rule the scan ran under. The flag is fixed when the scan job starts:
a resume (`{scanKey, resume: true}`) sends no photos and no flag and collects
what the job decided, and a duplicate full send with the same key joins the
running job and gets the same answer whatever it carries. The job key is the
user and `scanKey` only, so no body field changes which job a resume finds.
The server does not reject unknown body keys, so services 16 and 17 ignore the
flag.

The paper error is the measure the checksum retry compares reads by, but it is
always taken against the printed paper: the photo-first paper check of the
printed net subtotal, the `פריטים` counter and the row arithmetic. This holds
even when the client typed an anchor. Ranking by distance to a typed anchor
would let a misread that lands near a wrong anchor beat the correct reads, skip
the stop for a paper that disproves the typed anchor, and buy a checksum retry.
The typed anchor is checked against the selected read afterwards, as before.
The paper check is service 17's, so a credit note whose title was cut closes in
absolute value and a mixed paper whose returns exceed its goods closes with its
own sign: neither costs a read any paper error. The measure is counted in whole
agorot, with a shekel of gap, a line off the counter and each other paper
problem weighing 100 each, so two reads the same number of agorot off are a
true tie rather than a floating-point draw. A document whose printed summary was
not read scores the same fixed penalty plus its problems in every read, instead
of rewarding the read with fewer rows or a smaller sum. The checksum retry
compares a retry against the read it replaces with the same measure for every
client; the weights are the ones it always had. Every read not selected, the
retry model's included, is a witness for `consensus.disputedRows` and
`consensus.missingRows`. `consensus.escalated` and `consensus.escalationModel`
still say that the third read happened and on which model;
`consensus.escalationSelected` says whether it is the read returned, and
`scanAudit.attempts[].paperError` records the measure each candidate got, in
shekels. Under the paper rule "escalated" therefore no longer means "the retry
model decided": the selected attempt in `scanAudit` says who did.
`consensus.escalationSelected` is reported truthfully under both rules: without
the flag it is false only when there was no escalation, the escalation failed,
or the checksum retry replaced the escalation read.

A lone read is no longer silent. When one cheap read failed and the escalation
failed too, the result has no witness — nothing to disagree with, which looked
exactly like agreement. It now carries `consensus.unverifiedSingleRead: true`
and a warning in `scan.warnings`, for every client.

## Service 17

Service 17 reads no document number: it was removed from the schema, the
prompt and the comparison of the reads. `docType` is `credit` only when a
credit note is visible, and `invoice` otherwise, also when the header is cut
or unreadable. The reads compare it as a credit note against anything else, so
a cut header no longer buys an escalation, and an unreadable header is a
regular document that is receivable when its paper closes. Every summary
amount is returned with its printed sign. Without a visible title, a minus on
the net subtotal, the items section total, the VAT amount or the total
including VAT marks a credit note: the paper is checked in absolute value, so a
corrective read cannot "fix" it by dropping the minus, and it goes to review
as "probably a credit note" with no paid retry. A mixed paper whose returns
exceed its goods closes with its own negative sign, also with no retry.

## Earlier services

Rows are compared by content, not by position. Until service 13 the two reads
of a photo were compared row i against row i, and a document whose reads
disagreed on the row count was disputed as a whole: on 17.9 one read saw 29
rows on a 28-row paper, and all 28 rows went to manual approval although the
selected read closed against the printed subtotal to the agora. Now reads
with the same row count are still compared row by row — a column shift keeps
the row count, and inside a run of rows with identical money only the
positional comparison sees the shifted code — while reads whose row counts
differ are aligned by similarity (code, quantity, unit price, line total)
keeping table order, so a row that one read split, duplicated or dropped
disturbs only itself. A field of a row is disputed only when another
read disagrees and no other read confirms the selected value: two of three
reads agreeing — the expensive one and a cheap one — settle it, and the
decision is not asked again. Against a single other read every difference
stays disputed, because there is no third opinion. The code is the exception:
every dissenting code is reported, with `confirmed` counting the reads that
agree with the selected one, because the app settles a code against the
catalog and the printed price and needs the rival code to do so — the `other`
value is the first code actually read, never the null of a read that could
not read it. A row that only the selected read saw is disputed on its
existence, unless the selected document closes against its printed line
counter and subtotal: such a paper cannot hold an invented row, so the row
exists — but its identity stays a code question against "not read". A row
every other read saw and the selected read dropped is returned in
`consensus.missingRows` with a warning when the paper does not close, so the
gap in the sum comes with the row that explains it. Disputes are measured
against the read that actually won, also when the checksum retry replaced two
cheap reads that agreed with each other.

A scan outlives the connection that asked for it. Two parallel reads plus an
escalation take a minute and a half to two minutes, and a phone in a store does
not always hold a connection that long: a locked screen, a change of antenna or
a switch to another app cuts the answer in the middle. Until service 12 that
threw away a whole scan that had already been read and paid for, and the client
saw a truncated body with no error code and no audit. Now every scan is a job
under a key the client picks: the work continues without the connection, and a
client that reconnects with `{scanKey, resume: true}` collects the finished
result — no new photographs and no second payment. A key this instance never
saw answers `resume_unknown`, which tells the client to send the photos again.
Jobs are kept in memory for half an hour after they finish, an hour at most.
A request with no key behaves exactly as before.

Every scan is read twice in parallel by the base model. The two reads are
compared on row code, quantity, unit price, line total, promotion star and
section, and on the document summary fields; the printed description and the
confidence are excluded, because they differ between correct reads. Identical
reads are accepted with no escalation. Any difference in a decision field — or
a read that failed, leaving no second opinion — escalates to one call on the
retry model with a corrective note naming where the reads differed and the
known column-shift failure. The escalation read is returned, except that since
service 18 a client that sends `strongReadSelection: true` gets the read whose
paper closes best, ties going to the retry model. Rows the reads disagreed on and no
second read confirms are returned in `consensus.disputedRows` and raise a
warning, because a paper whose money closes perfectly can still carry an
identity read from the wrong row. `OPENAI_CONSENSUS_READS=1` restores the
single-read behaviour.

A call that never reached the model is not an answer: a read that fails with a
network error inside the first minute is retried once, because a fast failure
is a dropped connection rather than a slow read, and because the retry then
still fits inside the client's waiting window. A failure after the model
actually read is never retried.

Photo-first requests omit typed subtotal/line anchors. The server verifies
each paper against its own printed net subtotal and item-line count. It uses
integer agorot, subtracts the separate promotion discount and return section,
and checks quantity × printed unit price with the existing unit-rounding
allowance. Printed values are never replaced by calculated values.

Tnuva has no printed unit-count anchor. Crates are ordinary product rows;
deposit rows count as money, and all printed item rows count toward `פריטים`.
Repeated product codes remain separate printed rows.

Missing printed summary fields request review without a paid reread. Other
internal contradictions permit one retry using the configured retry model
and tier. A failed/worse retry preserves the first read. A self-consistent
paper that disproves typed anchors stops without escalation.

Credit notes and mixed invoices retain their raw supplier fields, are marked
for separate review, and cannot automatically become ordinary goods receipts.
Existing manual receiving, returns, promotion-sheet and analyzer routes remain.

Every invoice model attempt is included in `scanAudit` and an
`invoice_scan_audit` log: model, requested tier, stage, times, result, usage,
request ID, validation, and whether that read was selected. No image or secret
is logged. Firebase authentication and the current service configuration are
unchanged.

## Tests and release

`npm test` runs deterministic arithmetic and the actual HTTP handler with
fixture Firebase signatures and mocked model responses. No paid requests.

The order of release no longer matters. Service 18 selects by the paper only
for a scan whose request carried `"strongReadSelection": true`, and only app
142 sends it. App 141 and older word every escalated dispute as "הכריע <model>
בקריאה שלישית"; against service 18 they keep the old selection, so a completed
escalation is still the read they are shown, and the wording stays true. The
rest of service 18 is safe for them: fewer escalations, a corrective note
without values, a warning on a lone read, and fields they ignore. App 142
against service 16 or 17: those services ignore the flag and return the
escalation read. App 142 reads `consensus.escalationSelected` and
`consensus.unverifiedSingleRead`. When service 16 or 17 omits them, it falls
back to their service-16 meaning: a completed escalation was selected, and a
lone read is derived from `completedReads`, `escalated` and the selected
attempt. Services 16 and 17 do not send `consensus.docDateUnconfirmed`. There
a date difference escalates and the retry model's read wins. The `docDate`
entry in `consensus.diffs` still carries both cheap reads' dates in `values`
(first cheap read, then second), so app 142 trusts the selected date when a
read other than the selected one read the same calendar day: either cheap date
after a completed escalation or a winning checksum retry, and the second cheap
date when the first cheap read was selected. It takes the selected read from
`scanAudit.attempts` and, without it, from the service-16 meaning of
`escalated`. Otherwise the date is treated as disputed. Deploy this source to
the existing `tnuva-ai-scan` service whenever it is ready, before or after app
142. `/health` must report `serviceVersion:18`, `strongReadSelection:true`,
`resumableScans:true`, `photoFirst:true`, `scanAuditVersion:1`,
`keyStatus:"ready"`, and `retryModel:"gpt-5.6-terra"` — without a retry model
the escalation runs on the base model and buys nothing.
Preserve the verified runtime configuration:

- `OPENAI_MODEL=gpt-5.6-luna`
- `OPENAI_RETRY_MODEL=gpt-5.6-terra`
- `OPENAI_RETRY_SERVICE_TIER=priority`
- Base service tier `default`, `fastMode:false`.

Then test real receiving in the store.
