#!/usr/bin/env bash
# speakd — stop, disable and remove every trace from this machine.
set -u
echo "==> Stopping and disabling the systemd user service..."
systemctl --user disable --now speakd.service 2>/dev/null || echo "    (no service was installed)"
systemctl --user reset-failed speakd.service 2>/dev/null || true
echo "==> Removing the installed unit and gateway..."
rm -f "$HOME/.config/systemd/user/speakd.service"
rm -rf "$HOME/speak-gateway"
echo "==> Removing voice models and speakd config..."
rm -rf "$HOME/.cache/piper-test"
rm -f "$HOME/.config/speakd/profile.json" "$HOME/.config/speakd/voices.json"
rmdir "$HOME/.config/speakd" 2>/dev/null || true
echo "==> Optionally removing the piper binary (comment out to keep)..."
uv tool uninstall piper-tts 2>/dev/null || echo "    (piper not present or already removed)"
echo "==> Killing any leftover process..."
pkill -f 'speakd\.mjs' 2>/dev/null && echo "    stopped a running speakd" || echo "    none running"
echo "==> Removing the Claude Code Stop hook, if present..."
python3 - <<'EOF'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
if os.path.exists(p):
    try:
        with open(p) as f: cfg = json.load(f)
        hooks = cfg.get("hooks", {})
        before = json.dumps(hooks)
        hooks["Stop"] = [g for g in hooks.get("Stop", []) if "127.0.0.1:8777" not in json.dumps(g)]
        if not hooks["Stop"]: del hooks["Stop"]
        if not hooks: cfg.pop("hooks", None)
        if json.dumps(cfg) != before:
            with open(p, "w") as f: json.dump(cfg, f, indent=2)
            print("    hook removed")
        else:
            print("    no speakd hook found")
    except Exception as e:
        print(f"    settings.json unreadable, skipped: {e}")
else:
    print("    no Claude settings file")
EOF
echo "==> Done. speakd is fully removed (nothing else was ever touched)."
