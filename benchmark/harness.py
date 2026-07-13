"""subprocess wrappers for pi commands. No LLM traffic from Python itself."""

import glob
import os
import subprocess
from config import PI_PATH

SESSION_DIR = os.path.expanduser("~/.pi/agent/sessions")


def _find_session_path(session_id: str) -> str | None:
    """Find the .jsonl session file by partial match on session_id."""
    pattern = os.path.join(SESSION_DIR, "**", f"*_{session_id}.jsonl")
    matches = glob.glob(pattern, recursive=True)
    return matches[0] if matches else None


def pi_oneshot(
    prompt: str,
    provider: str = "umans-proxy",
    model: str = "umans-coder",
    session: str | None = None,
    tools: bool = False,
    timeout: int = 120,
    continue_session: bool = False,
) -> str:
    """Run pi in non-interactive mode, return stdout.

    Multi-turn sessions:
      Turn 1: pi_oneshot(..., session="my-bench", continue_session=False)
              → uses --session-id to create the session
      Turn 2+: pi_oneshot(..., session="my-bench", continue_session=True)
              → resolves the session file path and uses --session <path> --continue
    """
    cmd = [PI_PATH, "--print", "--provider", provider, "--model", model]
    if not tools:
        cmd += ["--no-tools"]
    if session:
        if continue_session:
            path = _find_session_path(session)
            if path:
                cmd += ["--session", path, "--continue"]
            else:
                # Session not found, create new
                cmd += ["--session-id", session]
        else:
            # First turn: create session
            cmd += ["--session-id", session]
    else:
        cmd += ["--no-session"]
    cmd += ["-p", prompt]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return result.stdout


def pi_parallel(
    count: int,
    prompt_fn,
    provider: str = "umans-proxy",
    model: str = "umans-flash",
    timeout: int = 120,
) -> list:
    """Launch N parallel pi processes, wait for all."""
    procs = []
    for i in range(count):
        cmd = [
            PI_PATH,
            "--print",
            "--provider",
            provider,
            "--model",
            model,
            "--no-tools",
            "--no-session",
            "-p",
            prompt_fn(i),
        ]
        procs.append(
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        )
    for p in procs:
        p.wait(timeout=timeout)
    return [p.returncode for p in procs]
