Replace, insert, or delete a cell in a Jupyter notebook (.ipynb file).

Usage:
- notebook_path: absolute path to the .ipynb file
- cell_number: 0-indexed cell position
- new_source: new cell content (required for replace/insert)
- cell_type: "code" or "markdown" (default: "code")
- edit_mode: "replace" (default), "insert" (add new cell at index), "delete"
