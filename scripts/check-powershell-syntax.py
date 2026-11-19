#!/usr/bin/env python3
"""Controlla la sintassi di tutto il PowerShell del repository con il parser di PowerShell.

  * tutti i file .ps1 (esclusi node_modules, target, .git);
  * tutti i passi `run:` dei workflow con `shell: pwsh` / `shell: powershell` e quelli dei job su
    Windows senza `shell` (su Windows il predefinito di GitHub Actions è pwsh).

Le espressioni `${{ ... }}` vengono sostituite con un segnaposto prima dell'analisi. Serve `pwsh` e
PyYAML (`pip install pyyaml`). Esce con 1 se trova errori.

    python3 scripts/check-powershell-syntax.py            # controllo
    python3 scripts/check-powershell-syntax.py --self-test  # verifica che un errore noto venga rilevato
"""
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML mancante: pip install pyyaml")

ROOT = Path(__file__).resolve().parent.parent
EXPR = re.compile(r"\$\{\{.*?\}\}", re.S)
PS_SHELLS = {"pwsh", "powershell"}


def steps_of(workflow_file: Path):
    """Genera (etichetta, testo) per ogni passo PowerShell del workflow."""
    data = yaml.safe_load(workflow_file.read_text(encoding="utf-8"))
    for job_id, job in (data.get("jobs") or {}).items():
        runs_on = job.get("runs-on", "")
        runs_on = " ".join(runs_on) if isinstance(runs_on, list) else str(runs_on)
        default_shell = (job.get("defaults") or {}).get("run", {}).get("shell")
        on_windows = "windows" in runs_on.lower()
        for i, step in enumerate(job.get("steps") or []):
            run = step.get("run")
            if not isinstance(run, str):
                continue
            shell = step.get("shell") or default_shell or ("pwsh" if on_windows else "bash")
            if str(shell).split()[0] not in PS_SHELLS:
                continue
            label = f"{workflow_file.name}__{job_id}__{i + 1}_{step.get('name', 'passo')}"
            yield re.sub(r"[^A-Za-z0-9_.-]+", "_", label), EXPR.sub("GHEXPR", run)


def pwsh_parse(paths):
    cmd = ["pwsh", "-NoProfile", "-File", str(ROOT / "scripts" / "parse-ps1.ps1"), *map(str, paths)]
    return subprocess.run(cmd, text=True).returncode


def check(workflows: Path, extra_files=()):
    with tempfile.TemporaryDirectory(prefix="rs-ps-steps-") as tmp:
        n = 0
        for wf in sorted(workflows.glob("*.yml")):
            for label, text in steps_of(wf):
                (Path(tmp) / f"{label}.ps1").write_text(text, encoding="utf-8")
                n += 1
        print(f"Passi PowerShell dei workflow estratti: {n}")
        targets = [tmp, *extra_files]
        return pwsh_parse(targets)


def self_test() -> int:
    bad = "name: x\non: push\njobs:\n  a:\n    runs-on: windows-latest\n    steps:\n      - shell: pwsh\n        run: |\n          if (-not $ok) { throw \"Manca $script: qualcosa\" }\n      - run: Write-Host ${{ github.sha }}\n"
    good = bad.replace("$script: qualcosa", "${script}: qualcosa")
    with tempfile.TemporaryDirectory() as d:
        wf = Path(d) / "wf"
        wf.mkdir()
        (wf / "bad.yml").write_text(bad)
        print("-- atteso: errore di sintassi --")
        if check(wf) == 0:
            print("AUTOTEST FALLITO: l'errore noto non e' stato rilevato")
            return 1
        (wf / "bad.yml").write_text(good)
        print("-- atteso: nessun errore --")
        if check(wf) != 0:
            print("AUTOTEST FALLITO: il file corretto e' stato rifiutato")
            return 1
    print("Autotest superato.")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    rc = check(ROOT / ".github" / "workflows", [ROOT])
    sys.exit(rc)
