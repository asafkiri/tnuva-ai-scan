# Tnuva invoice scanner — service 19

## Service 19

Service 19 adds a second strong read. It runs for a field that the cheap reads
disagreed on, that the strong read decided, and that no cheap read confirms.
This is the owner's approved design, live with no trial period:

1. The two cheap reads agree: the read is accepted, as before.
2. They disagree: the strong read (`OPENAI_RETRY_MODEL`, Terra) reads the
   photo. A field where Terra agrees with one cheap read is accepted. This is
   the existing 2-of-3 rule, unchanged.
3. On a field where Terra agrees with neither cheap read, a second strong read
   (Terra#2) reads the whole note again. If Terra#2's whole read is identical
   to Terra's whole read, the field is accepted and the worker does nothing.
4. Otherwise the field goes to the worker as today, in
   `consensus.disputedRows`, with the selected read's value.

"Accepted" applies to one field of one row, never to a whole document.
Terra#2 never supplies a value. The selected read supplies every value, and
Terra#2 is never the selected read. Terra#2 never adds a dispute: it is not a
witness for `missingRows`, for `docDateUnconfirmed` or for a code.

### How Terra#2 decides: the whole read

This is the owner's final rule. It replaced a per-row vote, in which Terra#2's
reading of the asked printed line was matched by page, line, code and table
and then compared field by field. That vote is gone.

Terra#2's whole read is compared with Terra's whole read
(`scanSecondStrongWholeReadDifferences`):

- the same documents (one per `noteIndex`, in both reads);
- in each document, the same document type (a credit note or not), the same
  page count, and the same summary fields that the consensus compares:
  `vatPct`, `itemsSectionTotalExVat`, `promoDiscountExVat`,
  `itemsPrintedLines`, `returnsSectionTotalExVat`, `returnsPrintedLines`,
  `subtotalExVat`, `vatAmount`, `totalInclVat` and `roundingDiff`. The
  document date is left out. It is not a summary field, and the owner ruled
  in service 18 that it decides nothing;
- the same number of rows, in the same order;
- on every row, the same identity and the same quantity and money. Identity
  is the code plus the kind of row: items or returns (`section`), and
  deposit or not (`פיקדון` in the description, the test the service uses
  everywhere). Quantity and money are `quantity`, `unitPriceExVat` and
  `lineTotalExVat`. Tnuva rows have no other money fields.

Values are normalised as the consensus normalises them (`consensusValue`):
quantity to a thousandth, money to the agora, the code trimmed, and the
document type as credit against everything else. Nothing else is measured.
That covers descriptions (beyond the deposit test), confidence, warnings, the
promotion star, the page, and each read's own `lineNumber`. Tnuva paper prints
no line numbers, so the order of the rows is what is compared.

If, and only if, the two reads are identical, every asked field that also
passes C1 and C2 in the selected read is closed, with `closedBy:
"second_strong_read"`. If there is any difference anywhere, nothing closes.
That includes another row, another note of the scan, the order of the rows,
the row count, and a summary field. The asked fields go to the worker as
today, with `outcome: "not_identical"`, and the first differences are logged
(below). In particular, Terra#2 can read the asked field exactly like Terra
and still close nothing, because it read something else differently.

### When Terra#2 is asked (unchanged)

Only the decision changed. When Terra#2 is asked is the same as before, and
every ask-side safeguard is kept. They all err toward the worker.

**Every cheap read counts only for the printed line it read.** Step 3 asks
whether the cheap reads split on the asked printed line. That is decided from
what each cheap read saw in the asked printed line, never from the consensus
alignment that `diffs` and `disputedRows` use. The alignment pairs rows by
position when both reads have the same number of rows, and by content
otherwise. It pairs different printed lines when a read lists rows in another
order, skips one line and doubles another, or shifts one column against the
others, which is this paper's known failure. This matching decides only
whether to ask. It plays no part in how Terra#2 decides.

Tnuva paper prints no line numbers. `lineNumber` is each read's own count of
the rows, so a row's page, line and code name a printed line only if the read
kept its columns together. A read can keep the code column complete while its
quantity, unit price and line total cells slide one row; its line numbers then
follow the codes. Its row at the asked line carries the right code and the
numbers of the neighbouring line, and nothing in that row shows it. Only the
read's whole table shows it. Tnuva paper has also printed no note number since
service 17, and a read names each of its documents by its own `noteIndex`
label. A cheap read's reading of the asked line therefore counts only when the
paper, the row and the table all match.

The paper, when the scan holds more than one note (one note needs no check,
since there is no other paper to read):

- the read's document with the selected document's `noteIndex` carries the
  same printed `סהכ חייב מעמ` (`subtotalExVat`, to the agora, compared without
  its sign, because a minus is a C2 matter and not another paper);
- that subtotal appears on only one document of the scan, both in the selected
  read and in that read.

Two notes of one order often print the same products in the same order at the
same prices. A read that returns one under the other's `noteIndex` then passes
the row and the table rules with rows of the other paper. The subtotal is the
one printed value that tells the two papers apart (`other_subtotal`,
`subtotal_repeated`).

The row:

- the read has exactly one row with the same page and `lineNumber` as the
  selected row;
- that row carries exactly the selected row's code;
- that code appears on only one row of the document, both in the selected read
  and in that read.

The table, line by line against the selected read's table:

- **The same rows** (`lines_differ`): the same number of rows, and exactly one
  row at each page and line of the selected read. A row more or a row less is
  where a value column can slide against the codes.
- **No code moved** (`code_moved`): on no line does it read a code that the
  selected read has on another line, or that it reads on another of its own
  rows. A code it did not read, or a code that appears nowhere else (a misread
  digit), does not count against it. A code difference on another row is an
  ordinary reason to escalate.
- **Numbers on every row** (`numbers_missing`): every row other than the asked
  one has a quantity, a unit price and a line total. The cell a value column
  slid out of is left empty. A quantity or line total missing in the asked row
  itself only leaves that field without a reading, as below.
- **The same unit price on every line** (`price_differs`), the asked line
  included, apart from the unit price being asked about. A value column that
  slid across lines with different prices shows a neighbour's price. On the
  asked line this check cannot see it when the unit price is the asked field
  and Terra itself took the neighbouring line's price, because the comparison
  is with Terra.
- **No numbers read twice** (`numbers_repeated`): on no two neighbouring lines
  does it read the same quantity, unit price and line total, unless the
  selected read has exactly those numbers on both lines too. This is how a
  slide looks when its gap was filled by reading one line's numbers twice,
  including a slide across a single pair of same-price twins, which is this
  paper's known failure. Two lines that are alike in the selected read as well
  are not enough to clear it: a Terra that read 7 and 7 on twins printed 6 and
  2 does not vouch for a read of 6 and 6. The price is paid by the worker: a
  paper that really prints the same numbers on two neighbouring lines, which
  the selected read read differently, leaves its fields with the worker.

Anything else is "not matched", and the cheap read counts for neither side.
The table is judged as a whole, so a cheap read that missed a row, read
another unit price, moved a code or read a line's numbers twice anywhere in
the document counts for none of its lines. The code only identifies the
printed line here. It is not decided or reported, and no read becomes a
witness for a code. This applies to step 3 only. `diffs`, `disputedRows`,
`missingRows`, the 2-of-3 rule and everything else in service 18 are
unchanged, and with the switch off nothing of this runs.

If the selected row has no `lineNumber`, no code, or a code (or a page and
line) that it shares with another row, no reading can be matched. The same
holds when another row of the selected table has no page and line of its own,
or lacks a quantity, unit price or line total (`table_unclear`), because then
no table can line up with it, and, in a scan of several notes, when the
selected document has no printed subtotal (`no_subtotal`) or shares it with
another of its documents (`subtotal_repeated`), because then no document of
another read can be told to be that paper. In these cases no field of that row
is asked about and no extra read is bought for it. When that is the only reason
nothing is asked, `outcome` is `not_matchable` instead of `not_needed`.

**What the ask-side rules cannot see.** Suppose a cheap read's value column
slid only across rows that all have the same unit price (or, when the unit
price is the asked field, after Terra itself took the neighbouring line's
price), and the gap it left was filled without an empty row, a moved code, a
different row count or a line's numbers read twice. For example, an extra or
invented row of numbers at the same price filled it, under a code that appears
nowhere else. Or the repeated numbers are exactly what the selected read has
on both lines. Then that cheap read still counts at the asked line, with its
neighbour's numbers, and it can qualify a field that only the other cheap read
really read. Likewise, a cheap read that swapped the labels of two notes still
counts if it also misread one note's subtotal as exactly the other's printed
subtotal. The field is then asked, and it closes only if Terra#2 reads the
whole note exactly as Terra did. That leaves one remaining risk, which the
owner accepted: two strong reads that make the same mistake.

**Step 3 needs cheap reads that disagree on that field.** A field is asked
about only when every cheap read that completed read the asked printed line by
the rule above, with a value in that field (a value that was not read, `null`,
does not count), when there are at least two such readings, when no two of them
are equal, and when none equals Terra's value. With the default two cheap
reads, both are matched, both have a value, and the two differ. With
`OPENAI_CONSENSUS_READS=3`, every completed cheap read (at least two) is matched
and has a value, and all of them differ. A cheap read that failed is not a
witness. This rule works per field and per row. The scan may escalate because of
a difference somewhere else, such as another row's code. If two cheap reads read
this field alike, that is step 1. Terra disagreeing with them does not make
Terra right, and a second strong read that repeats the same mistake makes it two
against two, not a decision. One case shows this: two same-price twins on
adjacent rows whose quantities and totals Terra swapped. The paper still closes
and each row's arithmetic still closes, so C1 cannot catch it. The same holds
when only one cheap read has a reading of the line. The other one failed, did
not read that field, or is not matched to that line, by its row or by its
table. It may have read exactly what the other one read, so two strong reads do
not outvote the one that did. In all these cases the field goes to the worker,
as in service 18.

Terra#2 seconds Terra only. When a client sends `strongReadSelection: true`
and a cheap read is selected because its paper closes better, Terra has
already disagreed with that read on every open field. Two strong reads that
disagree confirm nothing, so no extra read is bought. Apart from that, the rule
does not depend on the flag: it only removes disputes.

### The slot

Terra#2 shares the checksum-retry slot. It runs only when the checksum retry
does not, so it never adds a model call to what service 18 could make. In the
worst case that is still six calls with the default two cheap reads: each
cheap read retried once after a quick network drop, the escalation, and the
slot (eight with `OPENAI_CONSENSUS_READS=3`, also as in service 18). The
worst-case wait does not grow.

- (a) If the selected paper fails and can be retried, the slot is service
  18's checksum retry, byte for byte: the same note, with no locations added,
  and the same selection. Nothing closes from it, whether it wins or loses.
  The fields that Terra#2 would have been asked about stay with the worker.
  They are logged in `notAsked` with `reason: "checksum_retry_slot"`, and
  `outcome` is `checksum_retry_slot`. An asked field needs a selected paper
  that closes, so this happens only in a scan of several notes, when another
  note fails.
- (b) Otherwise, if an eligible field is open after the escalation, one call
  runs with stage `second_strong_read`. Only this call can close fields.

A Terra#2 call that fails or times out changes nothing and is never retried.

### The five conditions

A field closes through Terra#2 only when Terra#2's whole read is identical to
Terra's and all five conditions hold:

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
  document must be `receivable`. On the ask side this is also judged on the
  cheap reads. If any cheap read saw a credit note, a minus summary or returns
  in that document (`review` of `tnuvaPaperCheck`), the document's fields are
  not asked about. They are not asked about either if any cheap read read the
  asked line as a deposit or a returns row. Terra#2 cannot see a credit note,
  a minus, returns or a deposit that Terra did not see, because any of those
  is a difference in the whole read. A code dispute stays exactly as in
  service 18, `confirmed` count included. That count drives the "manual
  approval" warning and the app's catalog route, so raising it would settle an
  identity. A row whose identity is still open is not asked about at all. Such
  a row has a code dispute in which no witness confirms the selected code
  (`confirmed: 0`). Its quantity and money stay with the worker, together with
  its code. If they closed, the card would hold only the code, and the app's
  same-price identity rule would settle it on its own. Terra#2 would then
  decide an identity indirectly.
- **C3, independence.** The note carries only locations (document, page,
  printed line, field name) and the known-failure warnings. It carries no
  value from any earlier read. The read uses the same photos and system prompt
  as the cheap reads, on `OPENAI_RETRY_MODEL` at high effort.
- **C4, logging.** `consensus.secondStrongRead` holds `{outcome, stage, model,
  requestId, asked, usage, closed, open, notAsked, differences}`, plus `error`
  when the call failed. The same object goes to `scanAudit.secondStrongRead`
  and to the `invoice_scan_audit` log line. On Cloud Run the logger is
  `console`, and `console.info` prints an object only to depth 2, so `closed`
  and `open` would print as `[Object]`. In the log line the record is
  therefore printed as one line of complete JSON that also carries
  `scanAuditId`, so the line stands on its own: `secondStrongRead:
  {"scanAuditId":"…","outcome":"identical",…,"closed":[…]}`. The response is
  unchanged, and with the switch off the record and the line are absent, as in
  service 18. Each entry in `closed` names `noteIndex`, `rowIndex`, `page`,
  `lineNumber`, `field` and the selected `value`, and it carries `closedBy:
  "second_strong_read"`. Under `reads` it lists each read's value: the
  selected read, what every cheap read saw in the asked printed line, and
  Terra#2's value at the same place in its identical table. A cheap read is
  shown as `{stage, value}`, or as `{stage, value: null, seen: false}` when it
  has no row at that page and line. It also carries `unmatched` when it is not
  matched: by the paper (`other_subtotal` or `subtotal_repeated`, only in a
  scan of several notes), by the row (`other_code`, `line_repeated` or
  `code_repeated`) or by the table (`lines_differ`, `code_moved`,
  `numbers_missing`, `price_differs` or `numbers_repeated`). A cheap read
  whose paper and row matched the line, but that saw a credit note, a minus or
  returns, or read the line as a deposit or a returns row, carries its value
  and `ineligible` (`credit_or_returns`, `deposit_row` or `returns_row`); this
  is judged before the table. `open` lists the fields that were asked about
  and left for the worker, in the same shape without Terra#2. Its `reason` is
  `not_identical` or `failed`, or `not_eligible`, which a selected read that
  passed the ask side cannot reach. `differences` lists the first ten
  differences between Terra's and Terra#2's whole reads, in comparison order,
  each with `values: [Terra, Terra#2]`. A document difference has `{noteIndex,
  scope: "document", field}`. Here `field` is a document field, or `rowCount`,
  or `document` (how many documents each read has under that `noteIndex`). A
  row difference has `{noteIndex, scope: "row", rowIndex, lineNumber, field}`,
  where `field` is `section`, `deposit`, `code`, `quantity`,
  `unitPriceExVat` or `lineTotalExVat`. `notAsked` lists each field that met
  service 18's "no witness confirms it" and the C1 and C2 conditions but was
  not asked about, in the same shape. Its `reason` is `not_matchable` (plus
  `unmatched`: `no_subtotal`, `subtotal_repeated`, `no_line_number`,
  `no_page`, `no_code`, `code_repeated`, `line_repeated` or `table_unclear`),
  `lone`, `cheap_agree`, `cheap_confirms`, `cheap_not_item_row` or
  `checksum_retry_slot`. Like `diffs`, it keeps at most 200 entries. The app
  ignores it; it is there for the log. The extra call is an ordinary attempt
  in `scanAudit.attempts`, with its usage, and its usage is also in the
  record's `usage`, which the log line prints in full.
- **C5, kill switch.** `SECOND_STRONG_READ=off` (also `false` or `0`) restores
  service 18. With it, the service sends byte-identical model requests and
  returns the same answer, and `secondStrongRead` is absent from the response
  and from the log. The default is on. `/health` reports `secondStrongRead`,
  which is true only when the switch is on and a retry model is configured,
  since without a retry model there is no strong read.

Possible values of `outcome`:

- `not_needed`: no extra read was asked anything.
- `not_matchable`: nothing was asked only because the selected row cannot be
  matched to one printed line of one paper.
- `checksum_retry_slot`: fields would have been asked, but the selected paper
  failed and the slot went to the checksum retry (case (a)).
- `identical`: Terra#2's whole read is identical to Terra's, and the asked
  fields closed.
- `not_identical`: Terra#2's whole read differs from Terra's somewhere, so
  nothing closed.
- `failed`: the Terra#2 call failed.

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
