"""Tests for fuzzy patch functionality via hotpath CLI integration."""

from pathlib import Path

import pytest
from llama_studio_agent.tools.base import ToolContext, ToolExecutionError
from llama_studio_agent.tools.filesystem import (
    ApplyPatchTool,
    _split_patch_with_diff,
)


class TestSplitPatchWithDiff:
    """Test the _split_patch_with_diff helper function."""

    def test_single_file_patch(self):
        """Test splitting a patch with a single file."""
        diff = """--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3"""
        
        result = _split_patch_with_diff(diff)
        assert len(result) == 1
        file_path, file_diff = result[0]
        assert file_path == "file.txt"
        assert "--- a/file.txt" in file_diff
        assert "+++ b/file.txt" in file_diff
        assert "@@ -1,3 +1,3 @@" in file_diff

    def test_multi_file_patch(self):
        """Test splitting a patch with multiple files."""
        diff = """--- a/file1.txt
+++ b/file1.txt
@@ -1,2 +1,2 @@
 line1
-line2
+line2-modified
--- a/file2.txt
+++ b/file2.txt
@@ -1,2 +1,2 @@
 foo
-bar
+baz"""
        
        result = _split_patch_with_diff(diff)
        assert len(result) == 2
        
        path1, diff1 = result[0]
        assert path1 == "file1.txt"
        assert "line2-modified" in diff1
        
        path2, diff2 = result[1]
        assert path2 == "file2.txt"
        assert "baz" in diff2

    def test_empty_patch_raises_error(self):
        """Test that an empty patch raises an error."""
        with pytest.raises(ToolExecutionError, match="no file headers"):
            _split_patch_with_diff("")

    def test_patch_with_no_headers_raises_error(self):
        """Test that a patch without file headers raises an error."""
        diff = """@@ -1,2 +1,2 @@
 line1
-line2
+line2-modified"""
        
        with pytest.raises(ToolExecutionError, match="no file headers"):
            _split_patch_with_diff(diff)


class TestApplyPatchTool:
    """Integration tests for ApplyPatchTool with fuzzy matching."""

    @pytest.fixture
    def tool(self):
        """Create an ApplyPatchTool instance."""
        return ApplyPatchTool()

    @pytest.fixture
    def ctx(self, tmp_path):
        """Create a tool context with a temporary workspace."""
        return ToolContext(workspace_root=str(tmp_path), session_id="test-session")

    @pytest.mark.asyncio
    async def test_apply_simple_patch(self, tool, ctx):
        """Test applying a simple patch without drift."""
        # Create initial file
        test_file = Path(ctx.workspace_root) / "test.txt"
        test_file.write_text("line1\nline2\nline3\n")
        
        # Apply patch
        diff = """--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3"""
        
        args = {"unified_diff": diff}
        result = await tool.execute(ctx, args)
        
        assert result.ok
        assert result.data["files_changed"] == ["test.txt"]
        assert test_file.read_text() == "line1\nline2-modified\nline3\n"

    @pytest.mark.asyncio
    async def test_apply_patch_with_drift(self, tool, ctx):
        """Test applying a patch when the file has drifted (extra lines added)."""
        # Create file with extra lines at the beginning
        test_file = Path(ctx.workspace_root) / "test.txt"
        test_file.write_text("extra1\nextra2\nline1\nline2\nline3\n")
        
        # Apply patch that expects line2 at line 2, but it's now at line 4
        diff = """--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3"""
        
        args = {"unified_diff": diff}
        result = await tool.execute(ctx, args)
        
        assert result.ok
        assert result.data["files_changed"] == ["test.txt"]
        # The fuzzy matcher should find line2 at line 4 and apply the change
        content = test_file.read_text()
        assert "line2-modified" in content

    @pytest.mark.asyncio
    async def test_apply_patch_fails_with_no_match(self, tool, ctx):
        """Test that patch application fails when context doesn't match."""
        # Create file with completely different content
        test_file = Path(ctx.workspace_root) / "test.txt"
        test_file.write_text("foo\nbar\nbaz\n")
        
        # Apply patch that expects different content
        diff = """--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3"""
        
        args = {"unified_diff": diff}
        result = await tool.execute(ctx, args)
        
        assert not result.ok
        assert "patch failed" in result.error

    @pytest.mark.asyncio
    async def test_apply_patch_creates_new_file(self, tool, ctx):
        """Test applying a patch that creates a new file."""
        test_file = Path(ctx.workspace_root) / "new_file.txt"
        
        # Patch to create a new file (from /dev/null)
        diff = """--- /dev/null
+++ b/new_file.txt
@@ -0,0 +1,3 @@
+line1
+line2
+line3"""
        
        args = {"unified_diff": diff}
        result = await tool.execute(ctx, args)
        
        assert result.ok
        assert result.data["files_changed"] == ["new_file.txt"]
        assert test_file.exists()
        content = test_file.read_text()
        assert "line1" in content
        assert "line2" in content
        assert "line3" in content

    @pytest.mark.asyncio
    async def test_apply_patch_multiple_files(self, tool, ctx):
        """Test applying a patch that modifies multiple files."""
        # Create initial files
        file1 = Path(ctx.workspace_root) / "file1.txt"
        file2 = Path(ctx.workspace_root) / "file2.txt"
        file1.write_text("alpha\nbeta\n")
        file2.write_text("foo\nbar\n")
        
        # Apply patch to both files
        diff = """--- a/file1.txt
+++ b/file1.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+beta-modified
--- a/file2.txt
+++ b/file2.txt
@@ -1,2 +1,2 @@
 foo
-bar
+bar-modified"""
        
        args = {"unified_diff": diff}
        result = await tool.execute(ctx, args)
        
        assert result.ok
        assert set(result.data["files_changed"]) == {"file1.txt", "file2.txt"}
        assert file1.read_text() == "alpha\nbeta-modified\n"
        assert file2.read_text() == "foo\nbar-modified\n"

    @pytest.mark.asyncio
    async def test_patch_target_escapes_workspace(self, tool, ctx):
        """Test that patches attempting to escape the workspace are rejected."""
        # Create a file inside the workspace
        test_file = Path(ctx.workspace_root) / "test.txt"
        test_file.write_text("line1\nline2\n")
        
        # Try to patch a file outside the workspace
        diff = """--- a/../outside.txt
+++ b/../outside.txt
@@ -1,2 +1,2 @@
 line1
-line2
+line2-modified"""
        
        args = {"unified_diff": diff}
        result = await tool.execute(ctx, args)
        
        assert not result.ok
        assert "escapes workspace" in result.error


class TestHotpathIntegration:
    """Test direct hotpath CLI integration for fuzzy patching."""

    def test_hotpath_apply_patch_strict(self, tmp_path):
        """Test hotpath.apply_patch with fuzz=0 (strict matching)."""
        from llama_studio_agent import hotpath
        
        test_file = tmp_path / "test.txt"
        test_file.write_text("line1\nline2\nline3\n")
        
        diff = """--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3"""
        
        result = hotpath.apply_patch(str(test_file), diff, fuzz=0)
        
        assert result["success"] is True
        assert result["applied_hunks"] == 1
        assert result["failed_hunks"] == []
        assert "line2-modified" in result["new_content"]

    def test_hotpath_apply_patch_fuzzy(self, tmp_path):
        """Test hotpath.apply_patch with fuzz=3 (fuzzy matching)."""
        from llama_studio_agent import hotpath
        
        # File with drift (extra lines at beginning)
        test_file = tmp_path / "test.txt"
        test_file.write_text("extra1\nextra2\nline1\nline2\nline3\n")
        
        # Patch expects line2 at line 2, but it's at line 4
        diff = """--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3"""
        
        result = hotpath.apply_patch(str(test_file), diff, fuzz=3)
        
        assert result["success"] is True
        assert "line2-modified" in result["new_content"]

    def test_hotpath_apply_patch_failure(self, tmp_path):
        """Test hotpath.apply_patch when patch cannot be applied."""
        from llama_studio_agent import hotpath
        
        test_file = tmp_path / "test.txt"
        test_file.write_text("completely\ndifferent\ncontent\n")
        
        diff = """--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3"""
        
        result = hotpath.apply_patch(str(test_file), diff, fuzz=3)
        
        assert result["success"] is False
        assert len(result["failed_hunks"]) > 0
        assert "reason" in result["failed_hunks"][0]
