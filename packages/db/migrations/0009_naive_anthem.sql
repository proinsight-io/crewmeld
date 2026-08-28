-- Drop tools.package_key. MinIO-backed package storage is replaced by NFS.
-- Path is now derived from tool.id via paths.toolCode.forBff(toolId).
-- See spec 2026-05-28-cross-platform-nfs-volume-design.md §7.1
ALTER TABLE "tools" DROP COLUMN IF EXISTS "package_key";