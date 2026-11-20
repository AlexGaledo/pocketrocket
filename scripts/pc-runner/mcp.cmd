@echo off
rem Starts the Toki MCP server for Claude Code (stdio). Needs Node 22+ on PATH.
node "%~dp0mcp.mjs" %*
