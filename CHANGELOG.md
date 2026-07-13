# Changelog

## Unreleased

- Rename `drain()` → `flush()` (breaking if you were calling it directly; interceptor/filter do this internally).
- Emit `outcome: 'timeout'` when a record's TTL expires instead of silently dropping the line.
- Move internal record state to Symbol keys so callers can't overwrite it via `addFields()`.
- Deliberately do NOT emit `error.stack` on the canonical line — too large, not group-by-able, and better handled by a dedicated error tracker correlated via trace ID.
- Wrap the underlying logger call in try/catch — observability failures no longer break the request.
- Skip `super.catch()` for non-HTTP transports (was misbehaving in hybrid apps).
- Fix deprecated `rxjs/operators` import.
- Remove load shedding (`maxActiveRecords`). It silently dropped canonical lines under load, exactly when you need them. The TTL sweep is the memory bound now: `recordTtlMs` clamps to a 1s minimum and can no longer be disabled.
- Guard `initialize()` against running outside a CLS context (was throwing per-request when ClsModule wasn't mounted).
- Validate `service` at boot — throw if empty.
- Add integration tests (13, all real Nest + supertest — no mocks).
- Add PII / redaction guidance to the README.

## 1.0.0 (2026-07-13)


### ⚠ BREAKING CHANGES

* maxActiveRecords option removed; recordTtlMs: 0 no longer disables the TTL (clamps to 1000).

### Features

* introduce namespace and handler fields to improve visablity and enhance metrics aggregation ([ad5d655](https://github.com/mohamed-elfiky/nestjs-canonical-log/commit/ad5d655ab3dceae3a36dace52cc6a8668b8b3b76))
* introduce stage field to track request lifecycle ([722104b](https://github.com/mohamed-elfiky/nestjs-canonical-log/commit/722104bbd80013a513653de024d9b1e4878647ea))
* remove load shedding, make TTL the only memory bound ([a6ff6d8](https://github.com/mohamed-elfiky/nestjs-canonical-log/commit/a6ff6d81705ffa0f67312d400901f5750d89707a))


### Bug Fixes

* harden misconfiguration, shutdown, and post-emit mutation paths ([e64e256](https://github.com/mohamed-elfiky/nestjs-canonical-log/commit/e64e2563b01866ab9a229cd46d1c9e339fdb8bfd))


### Performance Improvements

* coarse-grained TTL sweep instead of per-request timers ([e67f79b](https://github.com/mohamed-elfiky/nestjs-canonical-log/commit/e67f79b7bc42a1e16f4a753899999d48962b2fce))

## 0.1.0

Initial release. Interceptor + filter + middleware + CLS-backed record; one structured canonical line per HTTP request.
