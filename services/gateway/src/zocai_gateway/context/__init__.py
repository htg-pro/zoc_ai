"""Context Enrichment Bus (Layer 3) components.

Houses the RAG_Matcher, Steering_Compiler, MCP_Gateway, the scale-adaptive
token gate, and the Subprocess Shell Spawner / FS read adapter (native FS
reads in both modes, shell execution only in Agent Mode). This package
implements Requirement 8.
"""
