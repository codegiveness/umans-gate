# Security Policy

## Reporting a Vulnerability

If you find a security issue in umans-gate, please report it privately so we can fix it before any public disclosure.

You can use GitHub's private vulnerability reporting for this repository:

<https://github.com/codegiveness/umans-gate/security/advisories/new>

If you cannot use GitHub, email details to the maintainers at the contact address listed in the repository's metadata.

Please include:

- A clear description of the issue.
- Steps to reproduce or a proof of concept.
- The version of umans-gate you tested against.
- Any suggested mitigation if you have one.

We will acknowledge receipt as soon as possible, investigate, and keep you informed as we work on a fix.

## Supported Versions

Only the latest release and the `main` branch are tracked for security updates. Please upgrade to the latest release before reporting an issue.

## Safe Deployment Notes

The dashboard has no authentication and binds to `127.0.0.1:9090` by default. This default prevents remote access from other hosts. If you change the bind address to a public interface or run behind a reverse proxy, restrict access to trusted clients.

The proxy itself binds to `0.0.0.0:8080` by default; deploy it behind a network firewall or restrict the bind address to a private interface when serving untrusted networks.
