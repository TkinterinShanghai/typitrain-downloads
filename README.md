# Trainapps downloads and deployment control

This public repository contains the stable metadata used to publish Trainapps
desktop downloads and Cloudflare Pages deployments. It intentionally contains
no application source code, Cloudflare credentials, repository credentials, or
signed download URLs.

Cloudflare Pages builds run `scripts/fetch-pages-artifact.mjs <app-id>`. The
script reads the selected manifest from `deployments/`, downloads one protected
static-site archive from the private Trainapps R2 bucket, verifies its exact
size and SHA-256 digest, safely extracts it to `out/`, and confirms that the
embedded deployment marker matches the source commit in the manifest.

Artifacts are temporary: the private deployment workflow deletes each object
after Pages finishes, and the bucket has a one-day lifecycle fallback. A
historical control commit is therefore an audit record, not a rebuildable
artifact store; Cloudflare rollback uses its already-deployed immutable output.

The deployment manifests are automation-owned. Application changes belong in
the private `TippProgramm` repository, which builds and uploads the archives.
