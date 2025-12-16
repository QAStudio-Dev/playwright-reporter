# Contributing to Playwright Reporter for QA Studio

Thank you for considering contributing to this project! Here are some guidelines to help you get started.

## Development Setup

1. **Fork and clone the repository**

```bash
git clone https://github.com/QAStudio-Dev/playwright.git
cd @qastudio-dev/playwright
```

2. **Install dependencies**

```bash
npm install
```

3. **Build the project**

```bash
npm run build
```

## Project Structure

```
@qastudio-dev/playwright/
├── src/
│   ├── index.ts          # Main reporter class
│   ├── api-client.ts     # QA Studio API client
│   ├── types.ts          # TypeScript type definitions
│   └── utils.ts          # Helper functions
├── dist/                 # Compiled JavaScript (generated)
├── examples/             # Usage examples
├── tests/                # Unit tests (to be implemented)
├── package.json
├── tsconfig.json
└── README.md
```

## Development Workflow

### Making Changes

1. Create a new branch for your feature or bugfix:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes to the source files in `src/`

3. Build and test your changes:

   ```bash
   npm run build
   npm run lint
   ```

4. Test the reporter with a local Playwright project:
   ```bash
   npm link
   cd /path/to/playwright/project
   npm link @qastudio-dev/playwright
   ```

### Code Style

- Use TypeScript for all source files
- Follow the existing code style
- Add JSDoc comments for public APIs
- Use meaningful variable and function names
- Keep functions small and focused

### Type Safety

- Ensure all code is properly typed
- Avoid using `any` type
- Export types that users might need
- Use strict TypeScript settings

### Testing

When adding new features:

1. Add unit tests in the `tests/` directory
2. Test manually with a real Playwright project
3. Verify error handling and edge cases

### Committing Changes

1. Write clear, descriptive commit messages:

   ```
   feat: add support for custom test metadata
   fix: handle API timeout errors gracefully
   docs: update configuration examples
   ```

2. Keep commits focused on a single change
3. Reference issue numbers in commit messages when applicable

### Submitting Pull Requests

1. Push your changes to your fork:

   ```bash
   git push origin feature/your-feature-name
   ```

2. Open a pull request on GitHub

3. Provide a clear description of:
   - What changes you made
   - Why you made them
   - Any breaking changes
   - How to test the changes

4. Wait for review and address any feedback

## Feature Requests

Have an idea for a new feature? Great! Please:

1. Check existing issues to avoid duplicates
2. Open a new issue describing:
   - The problem you're trying to solve
   - Your proposed solution
   - Any alternatives you've considered
3. Wait for discussion before implementing

## Bug Reports

Found a bug? Please open an issue with:

1. A clear, descriptive title
2. Steps to reproduce the issue
3. Expected behavior
4. Actual behavior
5. Your environment (OS, Node version, Playwright version)
6. Any relevant error messages or logs

## Questions

For questions about usage, please:

1. Check the [README](README.md) documentation
2. Search existing issues
3. Open a new discussion or issue

## License

By contributing, you agree that your contributions will be licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

All contributions must comply with the AGPL-3.0 license terms. This means:

- Your code will be freely available for others to use and modify
- Any modifications to this software used on a network server must have their source code made available
- Derivative works must also be licensed under AGPL-3.0

See the [LICENSE](LICENSE) file for the full license text.

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow
- Assume good intentions

Thank you for contributing!
