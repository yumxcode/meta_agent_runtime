Read a file from the local filesystem. Returns file contents with line numbers.

Usage:
- file_path must be an absolute path
- Reads up to 2000 lines by default; use offset + limit for large files
- Supports text files, and Jupyter notebooks (.ipynb)
- Returns content in cat -n format: "   1	<line content>"
