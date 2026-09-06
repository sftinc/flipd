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
