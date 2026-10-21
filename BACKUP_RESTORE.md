# Backup and restore

Status: **release blocked**. Existing `ops/backup.sh` and `ops/restore.sh` are historical utilities and have not been adapted or validated for the private supervisor identity registry. Do not use them as a complete recovery solution for this branch.

Known gaps: live browser profile consistency, missing integrity checks and archive path validation, broad label-based selection, absolute-path handling, and omission of the supervisor registry/runtime migration. Restore must verify the exact container IDs registered by the supervisor; restored home data alone does not recreate an authorized container.

Required contract: home files, profiles/cookies, downloads, configuration and workspace persist through stop/start and home-volume reuse. System packages in the container writable layer survive stop/start but not recreation, image replacement or home-only backup. Runtime sockets are ephemeral and must be regenerated, not archived as credentials or durable data.

Before any existing-install migration, take a verified offline checkpoint of the control-plane database, supervisor registry (if present), selected home volumes and any required container-layer exports. Quiesce the specific application's guests gracefully. Do not stop unrelated workloads. Verify checksums, restore into an isolated installation, run browser/profile and token-revocation tests, then approve the migration. No migration or restoration was performed in this session.
