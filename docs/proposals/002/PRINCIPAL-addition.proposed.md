## Runner facts for planning (moved from CLAUDE.md, DECISIONS #NNN)

- A dependency counts as satisfied when it is `passed` (and `ACCEPT` for human gates); a `superseded` gate counts as satisfied only for the fix tasks the planning commit appended after it.
- Review attempts after `r0` (`<id>.r<k>a/b/c/d`), verifier repairs (`N.verify.g<n>`) and approval retries (`<A>.r<n>`) are written as explicit physical tasks in PRD §8 by the principal's planning commit; the generator expands only `review-set` and `needsCI`.
- An `interactive-principal` task or a plan request is done when a commit on its branch carries `<promise>DONE <id></promise>` in its message.
