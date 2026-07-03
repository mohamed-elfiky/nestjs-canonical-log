# Changelog

## Unreleased

- Rename `drain()` → `flush()` (breaking if you were calling it directly; interceptor/filter do this internally).
- Emit `outcome: 'timeout'` when a bag's TTL expires instead of silently dropping the line.
- Move internal bag state to Symbol keys so callers can't overwrite it via `addFields()`.
- Deliberately do NOT emit `error.stack` on the canonical line — too large, not group-by-able, and better handled by a dedicated error tracker correlated via trace ID.
- Wrap the underlying logger call in try/catch — observability failures no longer break the request.
- Skip `super.catch()` for non-HTTP transports (was misbehaving in hybrid apps).
- Fix deprecated `rxjs/operators` import.
- Persist the shed flag in CLS so a mid-request capacity change doesn't spawn a bag with a wrong start time.
- Validate `service` at boot — throw if empty.
- Add integration tests (13, all real Nest + supertest — no mocks).
- Add PII / redaction guidance to the README.

## 0.1.0

Initial release. Interceptor + filter + middleware + CLS-backed bag; one structured canonical line per HTTP request.
