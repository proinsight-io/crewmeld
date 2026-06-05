/**
 * rclone sync sidecar — bridges MinIO ↔ shared PVC working directory.
 *
 * Pod layout when this sidecar is applied (needsFileMount=true):
 *
 *     Pod
 *       volumes:
 *         sop-workspace (PVC, shared between containers)
 *       containers:
 *         rclone-sync  (this module) — runs `rclone rcd` and exposes a local
 *                                       HTTP API on 127.0.0.1:5572 that the
 *                                       skill container calls to trigger
 *                                       incremental copies between
 *                                       MinIO `sop/{execId}/` and
 *                                       `/workspace/{execId}/`.
 *         skill        (deploy-skill.ts) — runs user tool code; reads and
 *                                          writes /workspace/{execId}/ as
 *                                          plain local filesystem; never
 *                                          touches MinIO directly.
 *
 * Sync model (per tool call, driven by server wrapper):
 *   1. POST localhost:5572/sync/copy { srcFs: "minio:bucket/sop/{execId}/",
 *                                       dstFs: "/workspace/{execId}/" }
 *      → rclone pulls anything new from MinIO into the PVC; existing files
 *        with the same mtime/size are skipped.
 *   2. Run user tool code.
 *   3. POST localhost:5572/sync/copy { srcFs: "/workspace/{execId}/",
 *                                       dstFs: "minio:bucket/sop/{execId}/" }
 *      → rclone pushes anything new from PVC to MinIO; unchanged files
 *        are skipped.
 *
 * Credentials model:
 *   The MinIO credentials are NOT embedded in the generated Pod spec — the
 *   sidecar pulls them at startup via `envFrom: secretRef` from a K8s
 *   Secret in the deploy namespace (default: `minio-credentials`).
 *
 * Why a sidecar instead of putting rclone in the skill container:
 *   - Skill container stays small (no rclone binary baked in)
 *   - Sync state survives skill-container crashes
 *   - Multiple concurrent tool invocations on the same Pod (warm-pool /
 *     deployed-skill model) share one rclone process with its own
 *     connection pool to MinIO
 *
 * Cluster requirement: no kernel module is needed (rclone rcd is pure
 * user-space). Unlike the previous FUSE-based design this does NOT need
 * /dev/fuse access or `privileged: true`.
 */

/** rclone image — pinned. Override via env for air-gapped clusters. */
const RCLONE_IMAGE = process.env.K8S_RCLONE_IMAGE ?? 'docker.io/rclone/rclone:1.65'

/** Path inside both containers where the SOP workspace PVC is mounted. */
export const SKILL_WORKSPACE_PATH = '/workspace'

/**
 * Name of the K8s Secret holding the MinIO credentials and bucket name.
 * Must contain RCLONE_CONFIG_MINIO_* keys plus MINIO_BUCKET. Override via
 * env for non-default secret naming conventions.
 */
const RCLONE_SECRET_NAME = process.env.K8S_RCLONE_SECRET_NAME ?? 'minio-credentials'

/** Local port the rcd HTTP API listens on (loopback only). */
export const RCLONE_RCD_PORT = 5572

export interface RcloneSidecarSpec {
  /** Container spec to append to `spec.template.spec.containers`. */
  sidecarContainer: Record<string, unknown>
  /** Mount entry the skill container should add to its volumeMounts. */
  skillVolumeMount: Record<string, unknown>
  /**
   * Env vars to inject into the skill container so the server wrapper
   * knows where to find the rcd endpoint and what MinIO bucket/prefix to
   * sync.
   */
  skillEnv: Array<{ name: string; value: string }>
}

/**
 * Build the rclone-sync sidecar plus its plumbing. Callers attach the
 * returned pieces to a Pod spec that ALSO declares a `sop-workspace`
 * volume backed by the shared PVC (deploy-skill.ts owns that).
 *
 * The sidecar speaks rclone's remote-control protocol on
 * 127.0.0.1:5572 — the skill container hits it via plain HTTP and never
 * needs MinIO credentials of its own.
 */
export function buildRcloneSidecarSpec(): RcloneSidecarSpec {
  // rcd binds to all interfaces (:5572) so the kubelet's readiness probe
  // — which connects via Pod IP, not Pod-internal loopback — can reach it.
  // The skill container still talks to the sidecar over 127.0.0.1 since
  // they share a network namespace. No Service / NodePort / Ingress
  // exposes 5572 outside the Pod, and the sandbox NetworkPolicy blocks
  // cross-Pod traffic on this port, so --rc-no-auth stays safe.
  const rcloneCmd = [
    'set -e',
    'if [ -z "$MINIO_BUCKET" ]; then',
    '  echo "[rclone] FATAL: MINIO_BUCKET env not set. Did you create the K8s Secret with MINIO_BUCKET key?" >&2',
    '  exit 1',
    'fi',
    `mkdir -p ${SKILL_WORKSPACE_PATH}`,
    // Pre-create the root sop/ prefix (no-op if it already exists in
    // MinIO) so fresh buckets don't trip over a missing key on first list.
    'rclone mkdir minio:$MINIO_BUCKET/sop 2>/dev/null || true',
    `exec rclone rcd \\
      --rc-addr :${RCLONE_RCD_PORT} \\
      --rc-no-auth \\
      --transfers 8 \\
      --checkers 8 \\
      --low-level-retries 10 \\
      --contimeout 30s \\
      --timeout 60s`,
  ].join('\n')

  const sidecarContainer: Record<string, unknown> = {
    name: 'rclone-sync',
    image: RCLONE_IMAGE,
    imagePullPolicy: 'IfNotPresent',
    command: ['sh', '-c', rcloneCmd],
    envFrom: [{ secretRef: { name: RCLONE_SECRET_NAME } }],
    volumeMounts: [
      // The skill container mounts the same PVC at the same path — both
      // containers see the same files. No FUSE, no mountPropagation
      // gymnastics; just a plain ReadWriteOnce PVC shared inside one Pod.
      { name: 'sop-workspace', mountPath: SKILL_WORKSPACE_PATH },
    ],
    // No privileged, no SYS_ADMIN, no /dev/fuse — plain user-space process.
    resources: {
      limits: { cpu: '500m', memory: '256Mi' },
      requests: { cpu: '50m', memory: '64Mi' },
    },
    // rclone rcd rejects GET on /rc/* with 405; httpGet probe can only do
    // GET; and kubelet probes hit the Pod IP (not the container's
    // localhost). All three reasons argue for a plain TCP probe — if the
    // port is open, rcd is alive.
    livenessProbe: {
      tcpSocket: { port: RCLONE_RCD_PORT },
      initialDelaySeconds: 5,
      periodSeconds: 10,
      failureThreshold: 6,
    },
    readinessProbe: {
      tcpSocket: { port: RCLONE_RCD_PORT },
      initialDelaySeconds: 2,
      periodSeconds: 3,
      failureThreshold: 10,
    },
  }

  const skillVolumeMount: Record<string, unknown> = {
    name: 'sop-workspace',
    mountPath: SKILL_WORKSPACE_PATH,
  }

  // Skill container reads these to know:
  //   - where /workspace lives (so it can compute /workspace/{execId})
  //   - the rcd endpoint (so it can trigger MinIO ↔ PVC sync)
  //   - the bucket name (rcd's srcFs / dstFs need it)
  const skillEnv: Array<{ name: string; value: string }> = [
    { name: 'SOP_WORKSPACE', value: SKILL_WORKSPACE_PATH },
    { name: 'RCLONE_RCD_URL', value: `http://127.0.0.1:${RCLONE_RCD_PORT}` },
  ]

  return {
    sidecarContainer,
    skillVolumeMount,
    skillEnv,
  }
}
