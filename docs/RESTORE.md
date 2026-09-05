# RESTORE.md — evidence backup and restore

`.evidence/` (runtime state, transcripts, CI artifacts, reviews, human-gate records, close records) is host-owned and gitignored; it is the only thing in this project that git does not protect. The launchd agent `com.savagesystems.essaydown.evidence-backup` (`scripts/launchd/`) copies it to iCloud Drive every hour (additive rsync, never deletes on the target).

Restore onto a fresh checkout (run after `git clone`, before `ralph.sh`):

```bash
rsync -a "$HOME/Library/Mobile Documents/com~apple~CloudDocs/essaydown-evidence/" "$HOME/Developer/essaydown/.evidence/"
```

Then `ralph/ralph.sh doctor` must report nothing before `ralph.sh run` is used again.

Install the agent (once per machine): `cp scripts/launchd/com.savagesystems.essaydown.evidence-backup.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.savagesystems.essaydown.evidence-backup.plist`. Log: `/tmp/essaydown-evidence-backup.log`. Remove: `launchctl bootout gui/$(id -u)/com.savagesystems.essaydown.evidence-backup`. iCloud's "Optimize Mac Storage" may evict the copy to the cloud; the restore command downloads it back.
