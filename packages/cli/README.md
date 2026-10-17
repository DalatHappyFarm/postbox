# @dalathappyfarm/postbox-cli

Command line client for a self-hosted [Postbox](https://github.com/DalatHappyFarm/postbox): list letters, read one with its photos, and set its status.


```sh
pnpm build:cli
node packages/cli/dist/bin.js login https://<your-project>.pages.dev <ADMIN_TOKEN>
# optional: put `postbox` on the PATH
cd packages/cli && pnpm link --global
```

Config comes from `POSTBOX_URL` and `POSTBOX_TOKEN`, or from `~/.config/postbox/config.json` (written by `postbox login` with mode 600).
A config from the old `~/.config/fh/config.json` is copied once and the old file is kept.

```sh
postbox project add my-app "My App"   # prints the public key (pbk_...) for the app
postbox list [--project slug] [--status s] [--kind k] [--json]
postbox show 42 [--json]              # markdown brief; downloads every attachment to the temp dir and prints the paths
postbox status 42 doing               # new | doing | done | wont_fix
postbox note 42 "reproduced on iOS 19"
postbox done 42 --note "fixed in build 78"
```

