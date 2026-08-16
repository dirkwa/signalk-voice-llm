# Contributing

Bug reports, feature requests and pull requests are welcome.

Before opening a PR, please run the checks the CI runs:

```bash
npm run format        # prettier --write, then eslint --fix
npm run build:all     # ci-lint, then tsc, then the test suite
```

Tests live in `src/test/` and drive the real plugin path — factory, `start()`,
a `voice.command` delta, the spoken reply — against a stub LLM over loopback
HTTP. New tests should assert observable behaviour (what was spoken, what
reached the LLM) rather than internal state.

Commits follow [Angular conventional commit](https://www.conventionalcommits.org/)
format (`fix(schema): spread defaults before reading config`). PR titles use the
same convention, since PRs are squash-merged and the title becomes the commit
subject.

## Licensing of contributions

By submitting a pull request or patch, you grant Dirk Wahrheit a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce,
modify, publish, sublicense and distribute your contribution, and to relicense
it under any terms, including as part of signalk-voice-llm releases. You confirm
that you have the right to grant this.

This keeps future licensing decisions for the project in one pair of hands. It
does not affect what you may do with your own contribution elsewhere — you keep
your copyright in it.
