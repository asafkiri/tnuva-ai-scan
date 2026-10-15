# Tnuva invoice scanner — service 19

## Service 19

Service 19 adds a second strong read. It runs for a field that the strong read
decided and no cheap read confirms. This is the owner's approved design, live
with no trial period:

1. The two cheap reads agree: the read is accepted, as before.
2. They disagree: the strong read (`OPENAI_RETRY_MODEL`, Terra) reads the
   photo. A field where Terra agrees with one cheap read is accepted. This is
   the existing 2-of-3 rule, unchanged.
3. On a field where Terra agrees with neither cheap read, a second strong read
   (Terra#2) reads the photo. If Terra#2 reads that field exactly as Terra did,
   the field is accepted and the worker does nothing.
4. Otherwise the field goes to the worker as today, in
   `consensus.disputedRows`, with the selected read's value.

"Accepted" applies to one field of one row, never to a whole document.
Terra#2 only votes for a value. The selected read supplies every value, and
Terra#2 is never the selected read. Terra#2 never adds a dispute: what it reads
elsewhere is not compared, and it is not a witness for `missingRows`, for
`docDateUnconfirmed` or for a code.

Terra#2 seconds Terra only. When a client sends `strongReadSelection: true`
and a cheap read is selected because its paper closes better, Terra has
already disagreed with that read on every open field. Two strong reads that
disagree confirm nothing, so no extra read is bought. Apart from that, the rule
does not depend on the flag: it only removes disputes.

**The slot.** Terra#2 shares the checksum-retry slot, so a scan still makes at
most four model calls and the worst-case wait does not grow:

- (a) If the selected paper fails and can be retried, the checksum retry runs
  as before. Its note is service 18's note, followed by the locations of the
  open fields that Terra#2 could settle. A retry that wins becomes the
  selected read, as before (`outcome: "selected"`), and it votes for nothing.
  A retry that loses is the extra read, and its votes count. A document whose
  sums the checksum note quotes is never asked about.
- (b) Otherwise, if an eligible field is open after the escalation, one call
  runs with stage `second_strong_read`.

A Terra#2 call that fails or times out changes nothing and is never retried.

**The five conditions.** A field closes through Terra#2 only when all five
hold:

- **C1, paper proof.** The selected document must pass `tnuvaPaperCheck`
  against its own printed `סהכ חייב מעמ` and `פריטים` counter. The row's own
  arithmetic must also close: quantity × unit price must equal the line total,
  within the rounded-unit allowance the paper check has always used. That
  allowance now lives in `tnuvaRowArithmetic`, and the paper check calls it.
  A row whose quantity, unit price or line total was not read cannot close.
- **C2, scope.** Only `quantity`, `unitPriceExVat` and `lineTotalExVat` of an
  ordinary item row can close. The following never close: the code, the
  promotion star, the section, the page, a row's existence, the row count, a
  summary field, the returns section, a deposit row (`פיקדון`), a credit note,
  a credit marked only by a minus, and a mixed paper. In practice the selected
  document must be `receivable`. A code dispute stays exactly as in service
  18, `confirmed` count included. That count drives the "manual approval"
  warning and the app's catalog route, so raising it would settle an identity.
- **C3, independence.** The note carries only locations (document, page,
  printed line, field name) and the known-failure warnings. It carries no
  value from any earlier read. The read uses the same photos and system prompt
  as the cheap reads, on `OPENAI_RETRY_MODEL` at high effort.
- **C4, logging.** `consensus.secondStrongRead` holds
  `{outcome, stage, model, requestId, asked, usage, closed, open}`, plus
  `error` when the call failed. The same object goes to
  `scanAudit.secondStrongRead` and to the `invoice_scan_audit` log line. Each
  entry in `closed` names `noteIndex`, `rowIndex`, `page`, `lineNumber`,
  `field` and the selected `value`, and it carries `rule:
  "second_strong_read"`. It also lists what every read saw under `reads`
  (`{stage, value}`, with `seen: false` for a read that did not see the row).
  `open` lists the fields that were asked about and left for the worker, with
  `reason` set to `disagrees`, `not_seen` or `failed`. The extra call is an
  ordinary attempt in `scanAudit.attempts`, with its usage.
- **C5, kill switch.** `SECOND_STRONG_READ=off` (also `false` or `0`) restores
  service 18. With it, the service sends byte-identical model requests and
  returns the same answer, and `secondStrongRead` is absent from the response
  and from the log. The default is on. `/health` reports `secondStrongRead`,
  which is true only when the switch is on and a retry model is configured,
  since without a retry model there is no strong read.

Possible values of `outcome`: `not_needed` (no extra read was asked anything),
`read`, `selected` (case (a) only) and `failed`.

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
and the document number is not compared because it is not read. The page a
row was assigned to, the VAT rate, the VAT amount, the total including VAT and
the rounding difference do not escalate: the app shows them as information or a
warning and computes with its own VAT setting and the printed net. A difference
in them is still returned in `consensus.diffs`, marked `trigger: false`, and
`consensus.agreed` is computed on the other differences only.

Two differences in those fields still escalate. The first is a sign
difference on the VAT amount or the total including VAT. Under service 17 a
minus on either one marks a credit note whose title was cut, so one read seeing
the minus and the other not is the difference between receiving goods and
stopping a credit note. If it did not escalate and the read without the minus
were the first one, the credit note would be received as goods. A value that
was not read (`null`) is not a minus. A difference in value with the same sign
(9 against 9.01, or −9 against −9.01) is still information only. A minus that
only one read saw on the net subtotal or the items section total was always a
money difference and escalates too.

The second is the document date, which (the owner's decision) costs nothing
only for a scan whose request carried `"strongReadSelection": true`, that is,
from app 142. App 142 knows not to trust a date nobody settled and checks
promotions against today instead. Apps up to 141 check promotion validity, and
141's "promotion not applied" card, against the printed date as read. So
without the flag a date difference escalates as it did in service 17: the
retry model settles it and, without the flag, its read is the one returned,
and the `docDate` entry in `consensus.diffs` carries no `trigger: false`. With
the flag, reads that differ only in the date cost one paid call less. Together
with service 17 this covers the photo whose header was cut: under service 17
the type no longer escalated, but the date that was usually cut with it still
did. For app 142 neither does now, and the date is named in
`consensus.docDateUnconfirmed` instead. For an older app the cut type still
costs nothing and the cut date escalates, exactly as in service 17.

Because for app 142 a date difference no longer buys the retry model, a cheap
read can be selected with a date nobody settled. The owner's decision is that a
date that was not read well defaults to today. The app uses the printed date
only as the day prices and promotion validity are checked against, so it needs
to know when not to trust that date. `consensus.docDateUnconfirmed` lists the `noteIndex` of
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
difference is still listed, and escalates exactly when any other date difference
does. Dates are compared directly
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
own sign. The measure uses the amount the paper check actually compared the
rows with (`checkedAmount` in `paperValidation`): the absolute value for a
credit note, and for a paper with a minus on a summary amount whichever of the
signed or absolute value is nearer the rows. `amount` stays the printed amount
with its sign. So keeping the minus never costs a read any paper error, also
when that read's paper fails for another reason, such as one misread quantity.
Measured against the signed amount, a credit read of −80 that kept its minus
and misread one quantity scored 161, while a read that dropped every minus and
misread two quantities scored 2. That read was then selected, and the credit
stop was lost. The same measure decides the checksum retry for every client, so
a retry that drops the minus no longer beats a first read that kept it with
the same number of problems. That bias was in service 17 too. The sign itself
is still not part of the measure: a read that dropped the minus and has fewer
other problems still wins over a read that kept it. The measure is counted in whole
agorot, with a shekel of gap, a line off the counter and each other paper
problem weighing 100 each, so two reads the same number of agorot off are a
true tie rather than a floating-point draw. A document whose printed summary was
not read scores the same fixed penalty plus its problems in every read, instead
of rewarding the read with fewer rows or a smaller sum. The checksum retry
compares a retry against the read it replaces with the same measure for every
client. The weights are the ones it always had, and only the amount a credit
note or a negative mixed paper is measured against changed, as above. Every read not selected, the
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

Service 19 can be deployed before or after any app. It adds the
`consensus.secondStrongRead` record and the `second_strong_read` stage in
`scanAudit.attempts`, and it only removes entries from
`consensus.disputedRows`. Apps up to 142 ignore the new record. App 142's
token counter lists only the `consensus*` stages, so the extra call shows up
only in `scanAudit` until the app lists it. `/health` must report
`serviceVersion:19` and `secondStrongRead:true`, as well as everything listed
for service 18 below. To roll back without a deploy, set
`SECOND_STRONG_READ=off`.

The order of release no longer matters. Service 18 selects by the paper, and
lets a date difference go without a paid read, only for a scan whose request
carried `"strongReadSelection": true`, and only app 142 sends it. App 141 and
older word every escalated dispute as "הכריע <model> בקריאה שלישית", and check
promotions against the printed date as read. Against service 18 they keep the
old selection, so a completed escalation is still the read they are shown and
the wording stays true. They also keep the old date rule: a date difference
escalates and the retry model's date is the one they get, as in service 17.
The rest of service 18 is safe for them: no escalation on the page, VAT rate,
VAT value or rounding, a sign difference on the VAT or the total that still
escalates (as in service 17), a corrective note without values, a warning on a
lone read, and fields they ignore. App 142
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
142. `/health` must report `serviceVersion:19` (18 for service 18 itself), `strongReadSelection:true`,
`resumableScans:true`, `photoFirst:true`, `scanAuditVersion:1`,
`keyStatus:"ready"`, and `retryModel:"gpt-5.6-terra"` — without a retry model
the escalation runs on the base model and buys nothing.
Preserve the verified runtime configuration:

- `OPENAI_MODEL=gpt-5.6-luna`
- `OPENAI_RETRY_MODEL=gpt-5.6-terra`
- `OPENAI_RETRY_SERVICE_TIER=priority`
- Base service tier `default`, `fastMode:false`.
- `SECOND_STRONG_READ` unset (on). Set it to `off` only to roll back to service 18.

Then test real receiving in the store.
