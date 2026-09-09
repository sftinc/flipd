// lib/cli/recipe.mjs
//
// The webhook recipe, rendered once here and printed by both `add` and
// `check`. `add` prints it at the moment the repo is created; `check` prints it
// whenever asked, which matters because `add` refuses to run twice and the
// natural first-time order -- add, then install.sh --host -- means `add` only
// ever saw a placeholder for the host.
//
// The gh step builds the hook's JSON body on node's stdin and posts it with
// `gh api ... --input -`, rather than `-f config[secret]=$(...)`: a value
// interpolated into a `gh` flag lands in `gh`'s own argv, published for the
// life of that process in /proc/<pid>/cmdline (readable by any local user with
// ps) and in the operator's shell history. `SECRET=$(...) node -e '...'` puts
// the secret in node's environment instead, which only its owner or root can
// read. test/recipe.test.mjs holds those properties.
import { fileURLToPath } from 'node:url';

export function webhookRecipe({ host, ghRepo, mainConf }) {
  return `add the webhook (Settings > Webhooks):
   Payload URL    https://${host}/deploy
   Content type   application/json
   Secret         the WEBHOOK_SECRET in ${mainConf}
   Events         just the push event
   SECRET=$(sudo sed -n 's/^WEBHOOK_SECRET=//p' ${mainConf}) node -e '
     process.stdout.write(JSON.stringify({ name: "web", active: true, events: ["push"],
       config: { url: "https://${host}/deploy", content_type: "json", secret: process.env.SECRET } }));
   ' | gh api repos/${ghRepo}/hooks --method POST --input -`;
}

// Where this clone's `flipd` lives, for the forced command in an
// authorized_keys line — rendered from the CLI's own location, the same way
// install.sh rewrites ExecStart for a clone outside /opt/flipd.
export const FLIPD_BIN = fileURLToPath(new URL('../../bin/flipd', import.meta.url));

// The SSH trigger recipe: the operator's half, with the repo name filled in.
// Instructions only. The keypair, the login user and the authorized_keys line
// are box administration, not flipd's — it generates no key, creates no
// user, writes nothing under ~/.ssh. Nothing here is a secret: the private
// half of the key never exists on this box.
export function sshRecipe({ name, ghRepo = '<owner>/<repo>', bin = FLIPD_BIN }) {
  return `trigger this repo over SSH (no PUBLIC_HOST, so no webhook):
   on your machine:  ssh-keygen -t ed25519 -f flipd-${name} -N ''
                     gh secret set FLIPD_SSH_KEY -R ${ghRepo} < flipd-${name}
   on this box:      a login user in group flipd -- a dedicated one; the doc says why
                     sudo usermod -aG flipd <login-user>
                     one line in that user's ~/.ssh/authorized_keys:
     command="${bin} trigger ${name} --wait",restrict <contents of flipd-${name}.pub>
   workflow, host key pinning and details: docs/triggering-over-ssh.md`;
}
