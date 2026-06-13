#!/usr/bin/env python3
"""Generate TypeScript types from Pydantic models.

This script converts all Pydantic models in shared_schema.models to TypeScript
interfaces, eliminating the need for manual synchronization between Python and
TypeScript type definitions.

Features:
- Handles all Pydantic v2 types (BaseModel, Enum, Literal, Union, Optional)
- Converts UUID to string, datetime to ISODateTime
- Generates discriminated unions for Annotated types with discriminators
- Preserves field descriptions as JSDoc comments
- Outputs formatted TypeScript matching the existing style
- Supports drift detection mode for CI

Usage:
    # Generate TypeScript types
    python generate_ts.py

    # Check for drift (CI mode)
    python generate_ts.py --check
"""

import argparse
import sys
from pathlib import Path
from typing import Any, get_args, get_origin

# Add the Python package to path
ROOT = Path(__file__).resolve().parents[1]  # packages/shared-types
PY_PKG = ROOT / "python"
sys.path.insert(0, str(PY_PKG))

from shared_schema import models  # noqa: E402

# Type mapping from JSON Schema to TypeScript
TYPE_MAP = {
    "string": "string",
    "integer": "number",
    "number": "number",
    "boolean": "boolean",
    "null": "null",
}


def format_ts_type(schema: dict[str, Any], required: bool = True) -> str:
    """Convert JSON Schema type to TypeScript type."""
    
    # Handle boolean schemas (True = any, False = never)
    if isinstance(schema, bool):
        ts_type = "unknown" if schema else "never"
        return ts_type if required else f"{ts_type} | null"
    
    # Handle $ref (references to other models)
    if "$ref" in schema:
        ref_name = schema["$ref"].split("/")[-1]
        return ref_name if required else f"{ref_name} | null"
    
    # Handle anyOf (unions)
    if "anyOf" in schema:
        types = [format_ts_type(s, required=True) for s in schema["anyOf"]]
        # Filter out null and make the type optional if null was present
        non_null_types = [t for t in types if t != "null"]
        has_null = "null" in types
        
        if len(non_null_types) == 1:
            ts_type = non_null_types[0]
            return f"{ts_type} | null" if has_null else ts_type
        else:
            union = " | ".join(non_null_types)
            return f"({union}) | null" if has_null else union
    
    # Handle arrays
    if schema.get("type") == "array":
        items_schema = schema.get("items", {})
        item_type = format_ts_type(items_schema, required=True)
        ts_type = f"{item_type}[]"
        # Only add | null if schema explicitly allows it, not just because field is optional
        return ts_type
    
    # Handle objects (dicts)
    if schema.get("type") == "object":
        # Check if it's a generic dict or has specific properties
        if "additionalProperties" in schema:
            additional = schema["additionalProperties"]
            # additionalProperties can be a boolean or a schema
            if isinstance(additional, bool):
                # If True, allow any value; if False, no additional properties
                value_type = "unknown" if additional else "never"
            else:
                value_type = format_ts_type(additional, required=True)
            ts_type = f"Record<string, {value_type}>"
        else:
            ts_type = "Record<string, unknown>"
        # Only add | null if schema explicitly allows it, not just because field is optional
        return ts_type
    
    # Handle basic types
    schema_type = schema.get("type")
    if schema_type in TYPE_MAP:
        ts_type = TYPE_MAP[schema_type]
        # Only add | null if schema explicitly allows it, not just because field is optional
        return ts_type
    
    # Handle special string formats
    if schema_type == "string":
        format_type = schema.get("format")
        if format_type == "uuid":
            return "UUID"
        elif format_type == "date-time":
            return "ISODateTime"
    
    # Fallback
    return "unknown" if required else "unknown | null"


def generate_enum_ts(name: str, enum_class: type) -> str:
    """Generate TypeScript type for a Python Enum."""
    values = [f'"{v.value}"' for v in enum_class]
    return f"export type {name} =\n  | " + "\n  | ".join(values) + ";\n"


def generate_interface_ts(name: str, model_class: type) -> str:
    """Generate TypeScript interface for a Pydantic model."""
    from typing import Literal
    
    schema = model_class.model_json_schema()
    
    # Get properties and required fields from schema
    properties = schema.get("properties", {})
    required_fields = set(schema.get("required", []))
    
    # Get Pydantic model fields to detect special cases
    model_fields = getattr(model_class, "model_fields", {})
    
    # Fields with default values (not None, not PydanticUndefined)
    # These should be required in TypeScript
    fields_with_defaults = set()
    for field_name, field_info in model_fields.items():
        # Check if field has a default value
        if field_info.default is not None:
            # Make sure it's not PydanticUndefined
            default_str = str(field_info.default)
            if 'PydanticUndefined' not in default_str:
                fields_with_defaults.add(field_name)
    
    # Fields with default_factory are always present after creation
    fields_with_default_factory = {
        field_name 
        for field_name, field_info in model_fields.items()
        if field_info.default_factory is not None
    }
    
    # Fields with Literal types and default values (discriminators)
    # These should be required with literal types
    literal_fields_with_defaults = {}
    for field_name, field_info in model_fields.items():
        # Check if field has a Literal type annotation
        annotation = field_info.annotation
        if (
            annotation
            and hasattr(annotation, '__origin__')
            and annotation.__origin__ is Literal
        ):
            # Get the literal values
            literal_values = annotation.__args__
            if len(literal_values) == 1:
                # Check if it has either a default value or default_factory
                has_default = field_info.default is not None
                has_default_factory = field_info.default_factory is not None
                if has_default or has_default_factory:
                    # Single literal value with a default - treat as required literal
                    literal_fields_with_defaults[field_name] = literal_values[0]
    
    # Check for inheritance
    extends = ""
    if hasattr(model_class, "__bases__"):
        for base in model_class.__bases__:
            if hasattr(base, "model_json_schema") and base.__name__ not in ["BaseModel", "_Base"]:
                extends = f" extends {base.__name__}"
                # Remove inherited fields from properties
                base_schema = base.model_json_schema()
                base_props = set(base_schema.get("properties", {}).keys())
                properties = {k: v for k, v in properties.items() if k not in base_props}
                required_fields = required_fields - base_props
                fields_with_default_factory = fields_with_default_factory - base_props
                literal_fields_with_defaults = {k: v for k, v in literal_fields_with_defaults.items() if k not in base_props}
                break
    
    lines = [f"export interface {name}{extends} {{"]
    
    for prop_name, prop_schema in properties.items():
        # Check if this is a literal discriminator field
        if prop_name in literal_fields_with_defaults:
            # Use the literal value as the type (required)
            literal_value = literal_fields_with_defaults[prop_name]
            ts_type = f'"{literal_value}"' if isinstance(literal_value, str) else str(literal_value)
            lines.append(f"  {prop_name}: {ts_type};")
            continue
        
        # A field is required if:
        # 1. It's in the schema's required list, OR
        # 2. It has a default value (always present after creation), OR
        # 3. It has a default_factory (always present after creation)
        is_required = (
            prop_name in required_fields 
            or prop_name in fields_with_defaults
            or prop_name in fields_with_default_factory
        )
        ts_type = format_ts_type(prop_schema, required=is_required)
        
        # Add optional marker if not required
        optional = "" if is_required else "?"
        
        # Add description as JSDoc if available
        description = prop_schema.get("description")
        if description:
            lines.append(f"  /** {description} */")
        
        lines.append(f"  {prop_name}{optional}: {ts_type};")
    
    lines.append("}\n")
    return "\n".join(lines)


def generate_discriminated_union_ts(name: str, union_type: Any) -> str:
    """Generate TypeScript discriminated union type."""
    from typing import Union
    
    args = get_args(union_type)
    if not args:
        return f"export type {name} = unknown;\n"
    
    # First arg is the Union type, second is the Field metadata
    union_arg = args[0]
    
    # Check if it's actually a Union
    if get_origin(union_arg) is Union:
        # Get the types from the Union
        union_types = get_args(union_arg)
        type_names = [t.__name__ for t in union_types if hasattr(t, '__name__')]
        
        if type_names:
            return f"export type {name} =\n  | " + "\n  | ".join(type_names) + ";\n"
    
    return f"export type {name} = unknown;\n"


def generate_typescript() -> str:
    """Generate complete TypeScript file from all Pydantic models."""
    
    # Header
    lines = [
        "/**",
        " * Shared TypeScript types for Llama Studio.",
        " *",
        " * AUTO-GENERATED from Python Pydantic models.",
        " * DO NOT EDIT MANUALLY - changes will be overwritten.",
        " *",
        " * To regenerate: pnpm schema:generate",
        " * Source: packages/shared-types/python/shared_schema/models.py",
        " */",
        "",
        "// Type aliases",
        "export type UUID = string;",
        "export type ISODateTime = string;",
        "",
    ]
    
    # Get all exported models
    all_models = models.__all__
    
    # Separate enums, interfaces, and unions
    enums = []
    interfaces = []
    unions = []
    
    for name in all_models:
        obj = getattr(models, name)
        
        # Check if it's an enum
        if isinstance(obj, type) and issubclass(obj, models.Enum):
            enums.append((name, obj))
        
        # Check if it's a Pydantic model
        elif isinstance(obj, type) and hasattr(obj, "model_json_schema"):
            interfaces.append((name, obj))
        
        # Check if it's a union type (Annotated with Union)
        elif get_origin(obj) is not None:
            unions.append((name, obj))
    
    # Generate enums first
    if enums:
        lines.append("// ── Enums ─────────────────────────────────────────────────────────────")
        lines.append("")
        for name, enum_class in sorted(enums):
            lines.append(generate_enum_ts(name, enum_class))
    
    # Generate interfaces
    if interfaces:
        lines.append("// ── Interfaces ────────────────────────────────────────────────────────")
        lines.append("")
        for name, model_class in sorted(interfaces):
            lines.append(generate_interface_ts(name, model_class))
    
    # Generate unions
    if unions:
        lines.append("// ── Union Types ───────────────────────────────────────────────────────")
        lines.append("")
        for name, union_type in sorted(unions):
            lines.append(generate_discriminated_union_ts(name, union_type))
    
    return "\n".join(lines)


def check_drift() -> bool:
    """Check if generated TypeScript matches the committed version."""
    ts_file = ROOT / "typescript" / "src" / "index.ts"
    
    if not ts_file.exists():
        print(f"❌ TypeScript file not found: {ts_file}", file=sys.stderr)
        return False
    
    # Generate new content
    new_content = generate_typescript()
    
    # Read existing content
    existing_content = ts_file.read_text()
    
    # Compare
    if new_content == existing_content:
        print("✅ TypeScript types are up to date")
        return True
    else:
        print("❌ TypeScript types are out of sync with Python models", file=sys.stderr)
        print("   Run 'pnpm schema:generate' to update", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Generate TypeScript from Pydantic models")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check for drift without writing (CI mode)",
    )
    args = parser.parse_args()
    
    if args.check:
        success = check_drift()
        sys.exit(0 if success else 1)
    else:
        # Generate TypeScript
        ts_content = generate_typescript()
        
        # Write to file
        ts_file = ROOT / "typescript" / "src" / "index.ts"
        ts_file.parent.mkdir(parents=True, exist_ok=True)
        ts_file.write_text(ts_content)
        
        print(f"✅ Generated TypeScript types: {ts_file.relative_to(ROOT)}")
        print(f"   Models: {len(models.__all__)}")


if __name__ == "__main__":
    main()
