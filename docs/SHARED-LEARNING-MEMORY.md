# Shared learning context (2.8.0)

The account memory is shared by text AI, writing review, spoken practice and dictation preferences. `lib/learning-memory` retains the existing `voice_learning_memories` D1 rows and CAS revision; no schema migration or account reassignment is performed. The legacy voice endpoint remains compatible.

## Boundaries

- Confirmed notes carry source/kind/update metadata. Legacy notes retain unknown dates. Model suggestions require the user's explicit save; a wrong answer does not create a long-term weakness.
- Recent topics and local practice evidence are distinct from confirmed notes. Full transcripts and writing drafts remain local; this feature adds no automatic cloud chat archive.
- AI use of this browser's existing learning profile requires explicit account-scoped opt-in. Existing anonymous voice/dictation histories remain in storage but are not silently assigned to an authenticated account.
- Temporary AI practice is tab-local: it omits historical context, AI caches, voice/dictation history and writing draft/review persistence. It does not disable the application's ordinary vocabulary study database or delete existing user data.
- Disabling personalization preserves saved notes but excludes notes and historical profiles from new AI requests. Editing/deleting notes increments revision and invalidates cached outputs.

## Request and cache binding

`/api/learning-memory` returns an opaque account scope, memory revision and configuration context version. Writes require matching scope and revision. Text, voice and dictation clients stamp requests and reject results if fresh context changes. Personalized cache keys include those stamps plus the actual profile content digest.

BroadcastChannel invalidates same-browser tabs without sending note content. Active Live sessions revalidate every 10 seconds and on focus/visibility recovery; failed verification stops local activity. Remote-device changes are therefore eventually detected, not instantaneously revoked. Server close failures retain the remote session ID and a visible retry action; local microphone stop is not represented as confirmed remote shutdown.

## Live dictation

The application chooses questions, keeps target answers away from the Live session, and grades normalized typed text deterministically. Device speech or verified TTS plays fixed questions. Live is an explicitly enabled, budgeted input channel for a small command whitelist and spelling transcription; its generated output is muted and excluded from visible captions.

Spelled input is editable and requires confirmation before scoring. Commands also require confirmation. Input segments without valid timing or preceding the capture window are dropped. Attempt/playback/capture IDs reject late events; submission is synchronous and idempotent. Hints/reveals make an attempt assisted and cannot resolve a stored mistake or count as independent mastery.

## Validation and limits

`npm test` covers source audit, type checking, 252 unit tests, build and Worker/D1 smoke (including isolation, temporary writes, stale revision, provenance and legacy compatibility). Mock browser checks cover three viewports, keyboard grading, reduced motion, no answer leakage before response, local-only temporary writing, account changes and close-failure recovery after memory invalidation.

No paid Live/TTS calls were made during implementation. Real microphone permissions, provider latency, transcription timing and audio playback still require a separately authorized real-service check. Live input timestamps are approximate; ambiguous or missing transcription fails safely to keyboard input rather than being graded automatically.
