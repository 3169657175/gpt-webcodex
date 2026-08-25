from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MCP_ROOT = ROOT / "resources" / "coding-tools-mcp"
VENDOR_ROOT = MCP_ROOT / "python_vendor"
sys.path.insert(0, str(VENDOR_ROOT))
sys.path.insert(0, str(MCP_ROOT))

from coding_tools_mcp import __version__  # noqa: E402
from coding_tools_mcp.server import (  # noqa: E402
    TOOL_MODE_ALLOWLISTS,
    TOOL_SCHEMA_VERSION,
    tool_definition,
    tool_schema_hash,
)

contract_path = MCP_ROOT / "schema-contract.json"
contract = json.loads(contract_path.read_text(encoding="utf-8"))
tools = [tool_definition(name) for name in sorted(TOOL_MODE_ALLOWLISTS["smart"])]
actual = {
    "runtime_version": __version__,
    "schema_version": TOOL_SCHEMA_VERSION,
    "schema_hash": tool_schema_hash(tools),
    "tool_count": len(tools),
}
if "--write" in sys.argv[1:]:
    contract_path.write_text(json.dumps(actual, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"MCP Schema 契约已更新：v{actual['schema_version']} · {actual['schema_hash'][:12]} · {actual['tool_count']} tools")
    raise SystemExit(0)
if contract != actual:
    print("MCP Schema 契约已过期，请更新 resources/coding-tools-mcp/schema-contract.json。", file=sys.stderr)
    print("expected:", json.dumps(actual, ensure_ascii=False, indent=2), file=sys.stderr)
    print("actual:", json.dumps(contract, ensure_ascii=False, indent=2), file=sys.stderr)
    raise SystemExit(1)
print(f"MCP Schema 契约一致：v{actual['schema_version']} · {actual['schema_hash'][:12]} · {actual['tool_count']} tools")
