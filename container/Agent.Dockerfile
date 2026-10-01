# Agent session container (deployed path, plan step 5).
# Based on Cloudflare's coding-agent-runner tutorial; wrangler builds this
# on `wrangler deploy -c wrangler.deploy.jsonc`.
FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Pin the Claude Code version: CLI flags and event format change between releases.
RUN npm install --global @anthropic-ai/claude-code@2.1.280

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
# Keep the container running between requests.
CMD ["sleep", "infinity"]
