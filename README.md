# Tnuva invoice scanner — service 11

Every scan is read twice in parallel by the base model. The two reads are
compared on row code, quantity, unit price, line total, promotion star and
section, and on the document summary fields; the printed description and the
confidence are excluded, because they differ between correct reads. Identical
reads are accepted with no escalation. Any difference — or a read that failed,
leaving no second opinion — escalates to one call on the retry model with a
corrective note naming the differences and the known column-shift failure, and
that read wins. Rows the reads disagreed on are returned in
`consensus.disputedRows` and raise a warning, because a paper whose money
closes perfectly can still carry an identity read from the wrong row.
`OPENAI_CONSENSUS_READS=1` restores the single-read behaviour.

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

Deploy this source to the existing `tnuva-ai-scan` service first. `/health`
must report `serviceVersion:11`, `photoFirst:true`, `scanAuditVersion:1`,
`keyStatus:"ready"`, and `retryModel:"gpt-5.6-terra"` — without a retry model
the escalation runs on the base model and buys nothing. Preserve the verified
runtime configuration:

- `OPENAI_MODEL=gpt-5.6-luna`
- `OPENAI_RETRY_MODEL=gpt-5.6-terra`
- `OPENAI_RETRY_SERVICE_TIER=priority`
- Base service tier `default`, `fastMode:false`.

Then release app 75 and test real receiving in the store.
