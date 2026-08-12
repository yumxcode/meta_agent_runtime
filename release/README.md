# release/

Packed tarballs (`npm pack` output). **Local artifacts only** — `.gitignore`
excludes `*.tgz`, so nothing in here is committed.

## Layout

```
release/
  meta-agent-runtime-<current>.tgz   ← the version in package.json, kept at the
                                       root so it is trivial to grab
  0.2/ 0.3/ … 0.8/                   ← every older build, bucketed by minor
```

Windows-specific builds keep a `-win` suffix and live in the same minor bucket
as their POSIX counterpart (e.g. `0.7/meta-agent-runtime-0.7.9-win.tgz`); there
is no separate top-level directory for them.

## After a release

`npm pack` writes to the repository root. Move it in and demote the previous
current build:

```sh
ver=$(node -p "require('./package.json').version")
mv "meta-agent-runtime-$ver.tgz" release/
# demote whatever else is sitting at release/ root
for f in release/meta-agent-runtime-*.tgz; do
  v=${f##*/meta-agent-runtime-}; v=${v%.tgz}
  [ "$v" = "$ver" ] && continue
  minor=$(echo "$v" | cut -d. -f1,2)
  mkdir -p "release/$minor" && mv "$f" "release/$minor/"
done
```
