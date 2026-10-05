# GitHub Actions Workflows

This repository uses GitHub Actions for automated testing, releases, and npm publishing.

## Workflows

### 1. CI Testing (`test.yml`)

**Trigger:** Push to `main` or `develop`, Pull Requests

**Purpose:** Runs automated tests and builds on multiple Node.js versions

**What it does:**

- Tests on Node.js 16, 18, and 20
- Runs type checking (`npm run lint`)
- Builds the package (`npm run build`)
- Runs tests (`npm test`)
- Verifies package can be packed

**No setup required** - runs automatically on pushes and PRs.

---

### 2. Publish to npm (`publish.yml`)

**Trigger:** When a GitHub Release is published

**Purpose:** Automatically publishes the package to npm

**What it does:**

- Installs dependencies
- Runs type checks
- Builds the package
- Publishes to npm with provenance
- Creates a summary of the published package

**Setup Required:**

1. **Add a Trusted Publisher on npmjs.com** (one-time, no rotating token):
   - Open https://www.npmjs.com/package/@qastudio-dev/playwright → Settings → Trusted Publisher
   - Publisher: GitHub Actions
   - Organization: `QAStudio-Dev`
   - Repository: `playwright-reporter`
   - Workflow filename: `publish.yml`
   - Enable **Allow npm publish** (required — the workflow runs `npm publish`, not `npm stage publish`)
   - Leave Environment name empty unless this workflow uses a GitHub Environment

2. **Do not set `NPM_TOKEN` / `NODE_AUTH_TOKEN`, and do not pass `registry-url` to `actions/setup-node@v4`.** That action exports a dummy `NODE_AUTH_TOKEN` (`XXXXX-XXXXX-XXXXX-XXXXX`) which overrides OIDC and produces `E404`.

**Usage:**
This workflow runs automatically when you publish a release, or via workflow_dispatch with tag `v1.5.0` (a leading `v` is optional).

---

### 3. Create Release (`release.yml`)

**Trigger:** Manual workflow dispatch

**Purpose:** Creates a new version, git tag, and GitHub release

**What it does:**

- Bumps the version in package.json (patch, minor, or major)
- Runs tests and builds
- Creates a git commit and tag
- Pushes to main branch
- Generates changelog from commits
- Creates a GitHub Release

**Setup Required:**

The workflow uses `GITHUB_TOKEN` which is automatically provided by GitHub Actions. No additional setup needed.

**Usage:**

1. Go to Actions tab in your repository
2. Click "Create Release" workflow
3. Click "Run workflow"
4. Select version bump type:
   - **patch** (1.0.0 → 1.0.1) - Bug fixes
   - **minor** (1.0.0 → 1.1.0) - New features, backward compatible
   - **major** (1.0.0 → 2.0.0) - Breaking changes
5. Click "Run workflow"

The workflow will:

- Create a new version
- Create a git tag (e.g., `v1.0.1`)
- Push to GitHub
- Create a GitHub Release

Once the release is created, the "Publish to npm" workflow will automatically trigger and publish the package to npm.

---

## Complete Release Process

### Automated (Recommended)

1. **Create Release:**
   - Go to Actions → "Create Release" → "Run workflow"
   - Choose version bump type (patch/minor/major)
   - Click "Run workflow"

2. **Publish Happens Automatically:**
   - Release workflow creates GitHub Release
   - Publish workflow automatically triggers
   - Package is published to npm

3. **Verify:**
   - Check npm: https://www.npmjs.com/package/@qastudio-dev/playwright
   - Check GitHub Releases: https://github.com/QAStudio-Dev/playwright/releases

### Manual (Alternative)

If you prefer to create releases manually:

1. **Bump version locally:**

   ```bash
   npm version patch  # or minor, or major
   ```

2. **Push with tags:**

   ```bash
   git push origin main --follow-tags
   ```

3. **Create GitHub Release:**
   - Go to Releases → "Draft a new release"
   - Choose the tag you just pushed
   - Write release notes
   - Click "Publish release"

4. **npm publish happens automatically** via the publish.yml workflow

---

## Workflow Dependencies

```
[Create Release]
       ↓
  Creates GitHub Release
       ↓
[Publish to npm]
       ↓
  Package available on npm
```

---

## Troubleshooting

### Publish workflow fails with "401 Unauthorized" or "404 Not Found"

- Confirm the Trusted Publisher on npmjs.com matches this repo and `publish.yml` exactly
- Confirm **Allow npm publish** is enabled on that trusted publisher
- Confirm the workflow does not set `NODE_AUTH_TOKEN` (an expired token looks like `E404`)
- Confirm the job uses Node 22.14+ / npm 11.5.1+ on a GitHub-hosted runner

### Release workflow fails with "Permission denied"

- The workflow needs write permissions for contents
- Check repository Settings → Actions → General → Workflow permissions
- Set to "Read and write permissions"

### Tests fail in CI but pass locally

- Check Node.js version (CI tests on 16, 18, 20)
- Verify package-lock.json is committed
- Check for environment-specific issues

---

## Security Notes

- Publishing uses npm Trusted Publishing (OIDC). Do not store a write-capable `NPM_TOKEN`
- Provenance attestations are generated automatically when publishing via OIDC
- Workflows use pinned actions (e.g., `@v4`) for security
- `GITHUB_TOKEN` has limited permissions scoped to the workflow

---

## Customization

### Change Node.js versions

Edit `test.yml`:

```yaml
matrix:
  node-version: [16, 18, 20, 21] # Add or remove versions
```

### Add pre-publish checks

Edit `publish.yml` and add steps before "Publish to npm":

```yaml
- name: Run integration tests
  run: npm run test:integration
```

### Customize changelog format

Edit `release.yml` in the "Generate changelog" step to change the format of commit messages.
