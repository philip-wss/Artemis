# Programming exercises: Fix flaky LocalCIDockerImageIntegrationTest for GCC LeakSanitizer

## Summary

The `LocalCIDockerImageIntegrationTest.setupCExerciseWithGcc_usesConfiguredDockerImage()` test fails intermittently on CI because it expects `TestCompileLeak` to pass. This test case compiles with `-fsanitize=leak`, which requires `liblsan` — a library not available on all architectures (notably ARM64/aarch64 where GCC does not support LeakSanitizer at all).

## Changes

- Removed `TestCompileLeak` from `GCC_TEST_CASE_NAMES` so it is no longer registered as an expected test case
- Updated the comment to explain that both `TestCompileLeak` and `TestOutputLSan` are excluded due to LeakSanitizer platform limitations

## Motivation

The test expected 7/7 GCC test cases to pass (score 100%), but on ARM64 CI runners the `TestCompileLeak` case fails because `-fsanitize=leak` is unsupported, resulting in 6/7 (score 85.7%). This follows the same exclusion pattern already applied to `TestOutputLSan`.

The `TestCompileLeak` and `TestOutputLSan` tests still execute inside the Docker container (via `Tests.py`), but since they are not registered as test cases in the database, they do not affect the score.

## Test plan

- [x] `setupCExerciseWithGcc_usesConfiguredDockerImage()` passes on both x86_64 and ARM64
- [x] `setupCExerciseWithFact_usesConfiguredDockerImage()` continues to pass (unaffected)
