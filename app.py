
from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8787"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"DashFlex: abra http://localhost:{port} no navegador (não use 0.0.0.0)")
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        reload=True,
        access_log=False,
    )
