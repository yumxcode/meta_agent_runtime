Echo a message back to the caller unchanged.

Use this tool when you need to verify that the tool-call round-trip is working
correctly, or when you want to surface a computed string as a tool result
without any transformation.

Input
-----
- `text` (string, required): The text to echo back.

Output
------
Returns the input `text` unchanged as a plain string.
