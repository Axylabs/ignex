#!/usr/bin/env python3
"""
LLM Context Generator v5.1 — Deep Debug Edition
Full code bodies + debug traces + call graphs + error propagation chains.
"""

import ast
import os
import re
import sys
import json
import stat
import fnmatch
import argparse
from abc import ABC, abstractmethod
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, List, Set, Optional, Tuple
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor

# ----------------------------------------------------------------------
# CONFIGURATION
# ----------------------------------------------------------------------
MAX_FILE_SIZE = 100_000
MAX_CODE_LINES = 500
DEFAULT_MAX_FILES = 50_000
DEFAULT_MAX_DEPTH = 3
DEFAULT_MAX_SYMBOLS = 60
DEFAULT_MAX_IMPORTS = 25
SKELETON_BODY_PEEK = 3

IGNORE_PATTERNS: Set[str] = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    ".idea", ".vscode", "dist", "build", ".next", ".nuxt",
    "coverage", ".pytest_cache", ".mypy_cache", ".tox", ".eggs",
    "*.pyc", "*.pyo", "*.so", "*.dylib", "*.dll", "*.exe",
    ".DS_Store", "*.log", "*.min.js", "*.min.css", "*.map",
    ".turbo", ".parcel-cache", ".cache", "out", ".output",
    "target", "bin", "obj", ".gradle", ".mvn","context.py"
}

SOURCE_EXTENSIONS: Set[str] = {
    '.py', '.pyi', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift',
    '.c', '.cpp', '.h', '.hpp', '.cc', '.cxx',
    '.cs', '.fs', '.fsx', '.rb', '.php', '.lua', '.r', '.R',
    '.sh', '.bash', '.zsh', '.vue', '.svelte', '.astro'
}

READMES = ("README.md", "README.rst", "README.txt", "README")

KEYWORDS: Set[str] = {
    'if', 'for', 'while', 'switch', 'case', 'default', 'return', 'break',
    'continue', 'goto', 'do', 'else', 'sizeof', 'typeof', 'offsetof',
    'asm', '__asm__', 'try', 'catch', 'throw', 'finally', 'with', 'yield',
    'await', 'delete', 'instanceof', 'in', 'of', 'pass', 'raise',
    'assert', 'import', 'export', 'from', 'as', 'new', 'this', 'super',
    'void', 'null', 'undefined', 'true', 'false',
}

# ----------------------------------------------------------------------
# DATA MODELS
# ----------------------------------------------------------------------
@dataclass
class Symbol:
    name: str
    kind: str
    line: int = 0
    params: str = ""
    ret: str = ""
    parent: str = ""
    interfaces: str = ""
    is_async: bool = False
    decorators: List[str] = field(default_factory=list)
    docstring: str = ""
    body_start: int = 0
    body_end: int = 0
    calls: List[str] = field(default_factory=list)
    throws: List[str] = field(default_factory=list)
    catches: List[str] = field(default_factory=list)


@dataclass
class ModuleInfo:
    path: str
    content: str = ""
    summary: str = ""
    imports: List[str] = field(default_factory=list)
    local_imports: List[str] = field(default_factory=list)
    exports: List[str] = field(default_factory=list)
    symbols: List[Symbol] = field(default_factory=list)
    error: Optional[str] = None
    error_sites: List[Tuple[int, str]] = field(default_factory=list)
    call_sites: List[Tuple[int, str, str]] = field(default_factory=list)


# ----------------------------------------------------------------------
# BASE PARSER
# ----------------------------------------------------------------------
class BaseParser(ABC):
    @property
    @abstractmethod
    def extensions(self) -> Set[str]:
        pass

    @abstractmethod
    def parse(self, content: str) -> ModuleInfo:
        pass


# ----------------------------------------------------------------------
# PYTHON PARSER (AST-based, debug-aware)
# ----------------------------------------------------------------------
class PythonParser(BaseParser):
    extensions = {'.py', '.pyi'}

    def parse(self, content: str) -> ModuleInfo:
        info = ModuleInfo(path="")
        info.content = content
        try:
            tree = ast.parse(content)
        except SyntaxError as e:
            info.error = f"SyntaxError: {e}"
            return info

        info.summary = ast.get_docstring(tree) or ""

        # Build import map for call resolution
        import_map: Dict[str, str] = {}
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname or alias.name
                    import_map[name] = alias.name
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                for alias in node.names:
                    name = alias.asname or alias.name
                    full = f"{module}.{alias.name}" if module else alias.name
                    import_map[name] = full

        for node in ast.iter_child_nodes(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    info.imports.append(alias.name)
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                names = [a.name for a in node.names]
                if module:
                    info.imports.append(f"{module}:{','.join(names)}")
                else:
                    info.imports.extend(names)
            elif isinstance(node, ast.ClassDef):
                bases = [self._fmt(b) for b in node.bases]
                cls_sym = Symbol(
                    name=node.name,
                    kind='class',
                    line=node.lineno,
                    parent=','.join(bases),
                    interfaces=','.join(f"{k.arg}={self._fmt(k.value)}" for k in node.keywords)
                )
                cls_sym.docstring = (ast.get_docstring(node) or "")[:200]
                cls_sym.body_start = node.lineno
                cls_sym.body_end = getattr(node, 'end_lineno', node.lineno)
                info.symbols.append(cls_sym)

                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        if item.name.startswith('_') and item.name not in ('__init__', '__call__', '__enter__', '__exit__', '__aenter__', '__aexit__'):
                            continue
                        self._process_function(item, info, import_map, class_name=node.name)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._process_function(node, info, import_map)
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                ann = self._fmt(node.annotation) if node.annotation else ""
                info.symbols.append(Symbol(name=node.target.id, kind='const', line=node.lineno, ret=ann))
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == '__all__':
                        if isinstance(node.value, (ast.List, ast.Tuple)):
                            for elt in node.value.elts:
                                val = self._const_val(elt)
                                if val:
                                    info.exports.append(val)

        return info

    def _process_function(self, node, info: ModuleInfo, import_map: Dict[str, str], class_name: str = "") -> None:
        params = self._get_params(node.args)
        ret = self._fmt(node.returns) if node.returns else ""
        decs = [self._fmt(d) for d in node.decorator_list]
        kind = 'method' if class_name else 'function'
        sym = Symbol(
            name=node.name,
            kind=kind,
            line=node.lineno,
            params=params,
            ret=ret,
            is_async=isinstance(node, ast.AsyncFunctionDef),
            decorators=decs,
        )
        sym.docstring = (ast.get_docstring(node) or "")[:200]
        sym.body_start = node.lineno
        sym.body_end = getattr(node, 'end_lineno', node.lineno)

        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                callee = self._resolve_call(child.func, import_map)
                if callee:
                    sym.calls.append(callee)
                    info.call_sites.append((child.lineno, sym.name, callee))
            elif isinstance(child, ast.Raise):
                err_type = ""
                if isinstance(child.exc, ast.Call) and isinstance(child.exc.func, ast.Name):
                    err_type = child.exc.func.id
                elif isinstance(child.exc, ast.Name):
                    err_type = child.exc.id
                elif child.exc is None:
                    err_type = "re-raise"
                if err_type:
                    sym.throws.append(err_type)
                    info.error_sites.append((child.lineno, err_type))
            elif isinstance(child, ast.ExceptHandler):
                if child.type:
                    if isinstance(child.type, ast.Name):
                        sym.catches.append(child.type.id)
                    elif isinstance(child.type, ast.Tuple):
                        for elt in child.type.elts:
                            if isinstance(elt, ast.Name):
                                sym.catches.append(elt.id)

        info.symbols.append(sym)

    def _resolve_call(self, func, import_map: Dict[str, str]) -> str:
        if isinstance(func, ast.Name):
            return import_map.get(func.id, func.id)
        if isinstance(func, ast.Attribute):
            base = self._resolve_call(func.value, import_map)
            return f"{base}.{func.attr}" if base else func.attr
        return ""

    def _const_val(self, node) -> Optional[str]:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if hasattr(ast, 'Str') and isinstance(node, ast.Str):
            return node.s
        return None

    def _fmt(self, node) -> str:
        if node is None:
            return ""
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Constant):
            return repr(node.value)
        if hasattr(ast, 'Str') and isinstance(node, ast.Str):
            return repr(node.s)
        if isinstance(node, ast.Attribute):
            return f"{self._fmt(node.value)}.{node.attr}"
        if isinstance(node, ast.Subscript):
            return f"{self._fmt(node.value)}[{self._fmt(node.slice)}]"
        if isinstance(node, ast.Call):
            args = ','.join(self._fmt(a) for a in node.args)
            return f"{self._fmt(node.func)}({args})"
        if isinstance(node, ast.List):
            return f"[{','.join(self._fmt(e) for e in node.elts)}]"
        if isinstance(node, ast.Tuple):
            return f"({','.join(self._fmt(e) for e in node.elts)})"
        return ""

    def _get_params(self, args) -> str:
        params = []
        for arg in args.args:
            ann = self._fmt(arg.annotation)
            params.append(f"{arg.arg}:{ann}" if ann else arg.arg)
        if args.vararg:
            params.append(f"*{args.vararg.arg}")
        if args.kwarg:
            params.append(f"**{args.kwarg.arg}")
        return ','.join(params)


# ----------------------------------------------------------------------
# REGEX LANGUAGE PARSER BASE
# ----------------------------------------------------------------------
class RegexLanguageParser(BaseParser):
    def __init__(self, string_delims: str = '"\'',
                 line_comment: Optional[str] = '//',
                 block_start: Optional[str] = '/*',
                 block_end: Optional[str] = '*/'):
        self.string_delims = string_delims
        self.line_comment = line_comment
        self.block_start = block_start
        self.block_end = block_end

    def _strip(self, content: str, preserve_strings: bool) -> str:
        result = []
        i = 0
        n = len(content)
        bs_len = len(self.block_start) if self.block_start else 0
        be_len = len(self.block_end) if self.block_end else 0
        lc_len = len(self.line_comment) if self.line_comment else 0

        while i < n:
            if content[i] in self.string_delims:
                quote = content[i]
                start = i
                i += 1
                while i < n:
                    if content[i] == '\\':
                        i += 2
                        continue
                    if content[i] == quote:
                        i += 1
                        break
                    i += 1
                if preserve_strings:
                    result.append(content[start:i])
                else:
                    result.append(' ' * (i - start))
            elif self.block_start and content[i:i + bs_len] == self.block_start:
                start = i
                i += bs_len
                while i < n and content[i:i + be_len] != self.block_end:
                    i += 1
                i += be_len
                result.append(' ' * (i - start))
            elif self.line_comment and content[i:i + lc_len] == self.line_comment:
                start = i
                while i < n and content[i] != '\n':
                    i += 1
                result.append(' ' * (i - start))
            else:
                result.append(content[i])
                i += 1
        return ''.join(result)

    def strip_comments_only(self, content: str) -> str:
        return self._strip(content, preserve_strings=True)

    def strip(self, content: str) -> str:
        return self._strip(content, preserve_strings=False)

    def _line_of(self, content: str, pos: int) -> int:
        return content[:pos].count('\n') + 1

    def parse(self, content: str) -> ModuleInfo:
        raise NotImplementedError


# ----------------------------------------------------------------------
# JAVASCRIPT / TYPESCRIPT PARSERS (debug-aware)
# ----------------------------------------------------------------------
class JSParser(RegexLanguageParser):
    extensions = {'.js', '.jsx', '.mjs', '.cjs'}

    def __init__(self):
        super().__init__(string_delims='"\'`', line_comment='//', block_start='/*', block_end='*/')

    def parse(self, content: str) -> ModuleInfo:
        info = ModuleInfo(path="")
        info.content = content
        comment_free = self.strip_comments_only(content)
        clean = self.strip(content)

        for m in re.finditer(r'import\s+(?:(?:[\w*\s{},]*)\s+from\s+)?[\'"`]([^\'"`]+)[\'"`]', comment_free):
            info.imports.append(content[m.start(1):m.end(1)])
        for m in re.finditer(r'require\s*\(\s*[\'"`]([^\'"`]+)[\'"`]\s*\)', comment_free):
            info.imports.append(content[m.start(1):m.end(1)])
        for m in re.finditer(r'export\s+\*\s+from\s+[\'"`]([^\'"`]+)[\'"`]', comment_free):
            info.imports.append(content[m.start(1):m.end(1)])

        for m in re.finditer(r'export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)', clean):
            info.exports.append(content[m.start(1):m.end(1)])
        for m in re.finditer(r'export\s*\{\s*([^}]+)\s*\}', clean):
            for name in m.group(1).split(','):
                n = name.strip()
                if n and not n.startswith('type '):
                    info.exports.append(n)

        for m in re.finditer(r'(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)', clean):
            info.symbols.append(Symbol(
                name=content[m.start(1):m.end(1)],
                kind='function',
                line=self._line_of(content, m.start(1)),
                params=content[m.start(2):m.end(2)],
                is_async='async' in m.group(0)
            ))

        for m in re.finditer(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:<[^>]*>)?\(([^)]*)\)\s*(?::\s*([^{=]+))?\s*=>', clean):
            info.symbols.append(Symbol(
                name=content[m.start(1):m.end(1)],
                kind='function',
                line=self._line_of(content, m.start(1)),
                params=content[m.start(2):m.end(2)],
                ret=content[m.start(3):m.end(3)].strip() if m.group(3) else "",
                is_async='async' in m.group(0)
            ))

        for m in re.finditer(r'(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w.,\s]+))?', clean):
            info.symbols.append(Symbol(
                name=content[m.start(1):m.end(1)],
                kind='class',
                line=self._line_of(content, m.start(1)),
                parent=content[m.start(2):m.end(2)] if m.group(2) else "",
                interfaces=content[m.start(3):m.end(3)].strip() if m.group(3) else ""
            ))

        class_names = {s.name for s in info.symbols if s.kind == 'class'}
        for m in re.finditer(r'(?:export\s+)?(?:type|interface|enum)\s+(\w+)(?:\s*[=<{;]|$)', clean):
            name = content[m.start(1):m.end(1)]
            if name not in class_names:
                info.symbols.append(Symbol(name=name, kind='type', line=self._line_of(content, m.start(1))))

        # Debug extraction
        imported = self._import_names(info.imports)
        for m in re.finditer(r'\bthrow\s+(?:new\s+)?(\w+)', clean):
            info.error_sites.append((self._line_of(content, m.start(1)), m.group(1)))
        for m in re.finditer(r'\bcatch\s*\(\s*(?:\w+\s*:\s*)?(\w+)', clean):
            info.error_sites.append((self._line_of(content, m.start(1)), f"catch:{m.group(1)}"))
        for m in re.finditer(r'\b(\w+)\s*\(', clean):
            name = m.group(1)
            if name in imported:
                info.call_sites.append((self._line_of(content, m.start(1)), "<module>", name))

        return info

    def _import_names(self, imports: List[str]) -> Set[str]:
        names = set()
        for imp in imports:
            if ':' in imp:
                names.update(imp.split(':')[-1].split(','))
            else:
                names.add(imp.split('/')[-1].split('.')[0])
        return names


class TSParser(JSParser):
    extensions = {'.ts', '.tsx', '.vue', '.svelte', '.astro'}

    def _extract_script(self, content: str) -> str:
        m = re.search(r'<script[^>]*>(.*?)</script>', content, re.DOTALL)
        return m.group(1) if m else content

    def parse(self, content: str) -> ModuleInfo:
        script = self._extract_script(content)
        return super().parse(script)


# ----------------------------------------------------------------------
# GO PARSER (debug-aware)
# ----------------------------------------------------------------------
class GoParser(RegexLanguageParser):
    extensions = {'.go'}

    def __init__(self):
        super().__init__(string_delims='"\'', line_comment='//', block_start='/*', block_end='*/')

    def parse(self, content: str) -> ModuleInfo:
        info = ModuleInfo(path="")
        info.content = content
        comment_free = self.strip_comments_only(content)
        clean = self.strip(content)

        for m in re.finditer(r'import\s*\(\s*([^)]+)\)', comment_free, re.DOTALL):
            for imp in re.finditer(r'(?:\w+\s+)?["\']([^"\']+)["\']', m.group(1)):
                info.imports.append(imp.group(1))
        for m in re.finditer(r'import\s+(?:\w+\s+)?["\']([^"\']+)["\']', comment_free):
            info.imports.append(m.group(1))

        for m in re.finditer(r'func\s+(?:\([^\)]*\)\s+)?(\w+)\s*\(([^)]*)\)\s*([\w\[\]*\.\s]*)', clean):
            ret = m.group(3).strip()
            info.symbols.append(Symbol(
                name=m.group(1),
                kind='function',
                line=self._line_of(content, m.start(1)),
                params=m.group(2),
                ret=ret
            ))

        for m in re.finditer(r'type\s+(\w+)\s+(struct|interface)', clean):
            kind = 'class' if m.group(2) == 'struct' else 'type'
            info.symbols.append(Symbol(name=m.group(1), kind=kind, line=self._line_of(content, m.start(1))))

        # Debug: error returns (Go idiom)
        for m in re.finditer(r'return\s+(?:[^,]+,\s*)?(\w+[Ee]rr(?:or)?)\b', clean):
            info.error_sites.append((self._line_of(content, m.start(1)), m.group(1)))

        return info


# ----------------------------------------------------------------------
# RUST PARSER
# ----------------------------------------------------------------------
class RustParser(RegexLanguageParser):
    extensions = {'.rs'}

    def _strip_rust(self, content: str, preserve_strings: bool) -> str:
        result = []
        i = 0
        n = len(content)
        while i < n:
            if content[i] in self.string_delims:
                quote = content[i]
                start = i
                i += 1
                while i < n:
                    if content[i] == '\\':
                        i += 2
                        continue
                    if content[i] == quote:
                        i += 1
                        break
                    i += 1
                if preserve_strings:
                    result.append(content[start:i])
                else:
                    result.append(' ' * (i - start))
            elif content[i:i + 2] == '/*':
                start = i
                depth = 1
                i += 2
                while i < n and depth > 0:
                    if content[i:i + 2] == '/*':
                        depth += 1
                        i += 2
                    elif content[i:i + 2] == '*/':
                        depth -= 1
                        i += 2
                    else:
                        i += 1
                result.append(' ' * (i - start))
            elif content[i:i + 2] == '//':
                start = i
                while i < n and content[i] != '\n':
                    i += 1
                result.append(' ' * (i - start))
            else:
                result.append(content[i])
                i += 1
        return ''.join(result)

    def strip_comments_only(self, content: str) -> str:
        return self._strip_rust(content, preserve_strings=True)

    def strip(self, content: str) -> str:
        return self._strip_rust(content, preserve_strings=False)

    def parse(self, content: str) -> ModuleInfo:
        info = ModuleInfo(path="")
        info.content = content
        comment_free = self.strip_comments_only(content)
        clean = self.strip(content)

        for m in re.finditer(r'use\s+([^;]+);', comment_free):
            info.imports.append(m.group(1).strip())

        for m in re.finditer(r'(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{;]+))?', clean):
            info.symbols.append(Symbol(
                name=m.group(1),
                kind='function',
                line=self._line_of(content, m.start(1)),
                params=m.group(2),
                ret=m.group(3).strip() if m.group(3) else "",
                is_async='async' in m.group(0)
            ))

        for m in re.finditer(r'(?:pub\s+)?(struct|enum|trait|type)\s+(\w+)', clean):
            kind = 'class' if m.group(1) == 'struct' else 'type'
            info.symbols.append(Symbol(name=m.group(2), kind=kind, line=self._line_of(content, m.start(2))))

        return info


# ----------------------------------------------------------------------
# JAVA PARSER
# ----------------------------------------------------------------------
class JavaParser(RegexLanguageParser):
    extensions = {'.java'}

    def __init__(self):
        super().__init__(string_delims='"\'', line_comment='//', block_start='/*', block_end='*/')

    def parse(self, content: str) -> ModuleInfo:
        info = ModuleInfo(path="")
        info.content = content
        comment_free = self.strip_comments_only(content)
        clean = self.strip(content)

        for m in re.finditer(r'import\s+([\w.]+);', comment_free):
            info.imports.append(m.group(1))

        for m in re.finditer(r'(?:public\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.<>]+))?(?:\s+implements\s+([\w.,\s<>]+))?', clean):
            info.symbols.append(Symbol(
                name=m.group(1),
                kind='class',
                line=self._line_of(content, m.start(1)),
                parent=m.group(2) if m.group(2) else "",
                interfaces=m.group(3).strip() if m.group(3) else ""
            ))

        for m in re.finditer(r'(?:public\s+)?interface\s+(\w+)(?:\s+extends\s+([\w.,\s<>]+))?', clean):
            info.symbols.append(Symbol(
                name=m.group(1),
                kind='type',
                line=self._line_of(content, m.start(1)),
                interfaces=m.group(2).strip() if m.group(2) else ""
            ))

        for m in re.finditer(r'(?:public|private|protected|static|abstract|final|synchronized)\s+(?:<[^>]*>\s*)?([\w\[\]<>.,\s]+)\s+(\w+)\s*\(([^)]*)\)', clean):
            ret = m.group(1).strip()
            name = m.group(2)
            if name not in KEYWORDS:
                info.symbols.append(Symbol(name=name, kind='method', line=self._line_of(content, m.start(2)), params=m.group(3), ret=ret))

        # Debug
        for m in re.finditer(r'\bthrow\s+(?:new\s+)?(\w+)', clean):
            info.error_sites.append((self._line_of(content, m.start(1)), m.group(1)))

        return info


# ----------------------------------------------------------------------
# C / C++ PARSERS
# ----------------------------------------------------------------------
class CParser(RegexLanguageParser):
    extensions = {'.c', '.h'}

    def __init__(self):
        super().__init__(string_delims='"\'', line_comment='//', block_start='/*', block_end='*/')

    def parse(self, content: str) -> ModuleInfo:
        info = ModuleInfo(path="")
        info.content = content
        comment_free = self.strip_comments_only(content)
        clean = self.strip(content)

        for m in re.finditer(r'#include\s+[<"]([^>"]+)[>"]', comment_free):
            info.imports.append(m.group(1))

        for m in re.finditer(r'(struct|enum|union)\s+(\w+)', clean):
            kind = 'class' if m.group(1) == 'struct' else 'type'
            info.symbols.append(Symbol(name=m.group(2), kind=kind, line=self._line_of(content, m.start(2))))

        for m in re.finditer(r'^\s*(?:[\w\s\*]+?)\s+(\w+)\s*\(([^)]*)\)\s*\{', clean, re.MULTILINE):
            name = m.group(1)
            if name not in KEYWORDS:
                info.symbols.append(Symbol(name=name, kind='function', line=self._line_of(content, m.start(1)), params=m.group(2)))

        for m in re.finditer(r'typedef\s+(?:struct\s+)?(?:enum\s+)?(?:union\s+)?[\w\s\*]+\s+(\w+);', clean):
            info.symbols.append(Symbol(name=m.group(1), kind='type', line=self._line_of(content, m.start(1))))

        return info


class CPPParser(CParser):
    extensions = {'.cpp', '.hpp', '.cc', '.cxx'}

    def parse(self, content: str) -> ModuleInfo:
        info = super().parse(content)
        clean = self.strip(content)

        for m in re.finditer(r'(?:class|struct)\s+(\w+)(?:\s*:\s*([\w\s,]+))?', clean):
            if not any(s.name == m.group(1) and s.kind == 'class' for s in info.symbols):
                info.symbols.append(Symbol(
                    name=m.group(1),
                    kind='class',
                    line=self._line_of(content, m.start(1)),
                    parent=m.group(2).strip() if m.group(2) else ""
                ))

        for m in re.finditer(r'(?:virtual\s+)?(?:static\s+)?(?:const\s+)?(?:[\w\s\*:]+)\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:const\s*)?(?:=\s*0\s*)?(?:override\s*)?(?:final\s*)?', clean):
            name = m.group(1)
            if name not in KEYWORDS:
                if not any(s.name == name and s.kind in ('function', 'method') for s in info.symbols):
                    info.symbols.append(Symbol(name=name, kind='method', line=self._line_of(content, m.start(1)), params=m.group(2)))

        return info


# ----------------------------------------------------------------------
# SHELL PARSER
# ----------------------------------------------------------------------
class ShellParser(RegexLanguageParser):
    extensions = {'.sh', '.bash', '.zsh'}

    def __init__(self):
        super().__init__(string_delims='"\'', line_comment='#', block_start=None, block_end=None)

    def parse(self, content: str) -> ModuleInfo:
        info = ModuleInfo(path="")
        info.content = content
        comment_free = self.strip_comments_only(content)
        clean = self.strip(content)

        for m in re.finditer(r'(?:source|\.)\s+["\']?([^"\';#\s]+)', comment_free):
            info.imports.append(m.group(1))
        for m in re.finditer(r'export\s+(\w+)=', clean):
            info.exports.append(m.group(1))

        for m in re.finditer(r'^(?:function\s+)?(\w+)\s*\(\)\s*\{', clean, re.MULTILINE):
            if m.group(1) not in KEYWORDS:
                info.symbols.append(Symbol(name=m.group(1), kind='function', line=self._line_of(content, m.start(1))))

        return info


# ----------------------------------------------------------------------
# STRICT PARSER REGISTRY (no generic fallback)
# ----------------------------------------------------------------------
class ParserRegistry:
    def __init__(self):
        self._parsers: Dict[str, BaseParser] = {}

        for parser in [
            PythonParser(), JSParser(), TSParser(), GoParser(),
            RustParser(), JavaParser(), CParser(), CPPParser(),
            ShellParser()
        ]:
            for ext in parser.extensions:
                self._parsers[ext] = parser

    def get(self, path: str) -> Optional[BaseParser]:
        ext = Path(path).suffix.lower()
        return self._parsers.get(ext)


# ----------------------------------------------------------------------
# PROJECT SCANNER
# ----------------------------------------------------------------------
class FileEntry:
    __slots__ = ('path', 'rel', 'size', 'content', 'info')
    def __init__(self, path: Path, rel: str, size: int):
        self.path = path
        self.rel = rel
        self.size = size
        self.content = ""
        self.info: Optional[ModuleInfo] = None


class ProjectScanner:
    def __init__(self, root: Path, extra_ignores: Set[str], max_files: int, include_vendor: bool):
        self.root = root
        self.max_files = max_files
        self.include_vendor = include_vendor
        self.ignores = self._load_ignores(extra_ignores)

    def _load_ignores(self, extra: Set[str]) -> Set[str]:
        igs = set(IGNORE_PATTERNS) | extra
        if self.include_vendor and "node_modules" in igs:
            igs.remove("node_modules")
        gitignore = self.root / ".gitignore"
        if gitignore.exists():
            try:
                with open(gitignore, 'r', errors='replace') as f:
                    for line in f:
                        line = line.rstrip()
                        if line and line[0] not in '#!' and not line.startswith('!'):
                            igs.add(line.rstrip('/'))
            except Exception:
                pass
        return igs

    def _compile_ignores(self, igs: Set[str]) -> Optional[re.Pattern]:
        parts = []
        for p in igs:
            if not p or p.startswith('#'):
                continue
            r = fnmatch.translate(p)
            if r.startswith('(?s:') and r.endswith('\\Z'):
                parts.append(r[4:-3])
            else:
                parts.append(r)
        if not parts:
            return None
        return re.compile('|'.join(f'(?:{r})' for r in parts))

    def scan(self) -> List[FileEntry]:
        entries: List[FileEntry] = []
        seen: Set[str] = set()
        roots = [self.root / c for c in ("src", "lib", "app", "source", "pkg", "cmd", "internal") if (self.root / c).is_dir()]
        if not roots:
            roots = [self.root]
        else:
            roots.append(self.root)

        ignore_re = self._compile_ignores(self.ignores)

        for root in roots:
            stack = [root]
            while stack:
                current = stack.pop()
                try:
                    items = list(os.scandir(current))
                except (PermissionError, OSError):
                    continue

                dirs = []
                for entry in items:
                    if ignore_re and ignore_re.match(entry.name):
                        continue

                    if entry.is_dir(follow_symlinks=False):
                        dirs.append(entry)
                    elif entry.is_file(follow_symlinks=False):
                        if not entry.name.lower().endswith(tuple(SOURCE_EXTENSIONS)):
                            continue
                        try:
                            st = entry.stat(follow_symlinks=False)
                            if not stat.S_ISREG(st.st_mode):
                                continue
                            fp = Path(entry.path)
                            rel = str(fp.relative_to(self.root))
                            if rel in seen:
                                continue
                            seen.add(rel)
                            entries.append(FileEntry(fp, rel, st.st_size))
                            if len(entries) >= self.max_files:
                                return entries
                        except (OSError, ValueError):
                            pass

                stack.extend(reversed(dirs))

        return entries


# ----------------------------------------------------------------------
# GRAPH BUILDER
# ----------------------------------------------------------------------
class GraphBuilder:
    def __init__(self, root: Path, entries: List[FileEntry]):
        self.root = root
        self.entries = entries
        self.entry_map = {e.rel: e for e in entries}
        self.seen = set(self.entry_map.keys())
        self.forward: Dict[str, List[str]] = defaultdict(list)
        self.reverse: Dict[str, List[str]] = defaultdict(list)

    def build(self) -> None:
        for entry in self.entries:
            if entry.info is None or entry.info.error:
                continue
            for imp in entry.info.imports:
                resolved = self._resolve_local(entry.rel, imp)
                if resolved and resolved in self.seen:
                    self.forward[entry.rel].append(resolved)
                    self.reverse[resolved].append(entry.rel)

    def _resolve_local(self, current: str, imp: str) -> Optional[str]:
        if not imp.startswith('.'):
            abs_candidate = self.root / imp.lstrip('/')
            if abs_candidate.is_file():
                try:
                    return str(abs_candidate.relative_to(self.root))
                except ValueError:
                    pass
                for ext in SOURCE_EXTENSIONS:
                    c = abs_candidate.with_suffix(ext)
                    if c.is_file():
                        try:
                            return str(c.relative_to(self.root))
                        except ValueError:
                            pass
            return None

        base = (self.root / current).parent
        parts = imp.split('/')
        for p in parts:
            if p == '.' or p == '':
                continue
            elif p == '..':
                base = base.parent
            else:
                base = base / p

        try:
            base.relative_to(self.root)
        except ValueError:
            return None

        if base.is_file():
            try:
                return str(base.relative_to(self.root))
            except ValueError:
                return None

        for ext in SOURCE_EXTENSIONS:
            cand = base.with_suffix(ext)
            if cand.is_file():
                try:
                    return str(cand.relative_to(self.root))
                except ValueError:
                    return None

        for idx in ('index.ts', 'index.js', 'index.tsx', 'index.jsx', 'index.py', 'mod.rs', 'lib.rs', 'mod.go', '__init__.py'):
            cand = base / idx
            if cand.is_file():
                try:
                    return str(cand.relative_to(self.root))
                except ValueError:
                    return None

        return None

    def topological_sort(self, files: Set[str]) -> List[str]:
        in_degree = {f: 0 for f in files}
        adj = defaultdict(list)

        for src, targets in self.forward.items():
            if src not in files:
                continue
            for tgt in targets:
                if tgt in files:
                    adj[tgt].append(src)
                    in_degree[src] += 1

        queue = deque(sorted([f for f in files if in_degree[f] == 0]))
        sorted_list = []

        while queue:
            node = queue.popleft()
            sorted_list.append(node)
            for neighbor in adj[node]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        remaining = sorted([f for f in files if f not in set(sorted_list)])
        sorted_list.extend(remaining)
        return sorted_list

    def bfs(self, start: str, graph: Dict[str, List[str]], max_depth: int) -> List[Tuple[str, int]]:
        visited = {start: 0}
        queue = deque([start])
        order = []

        while queue:
            node = queue.popleft()
            depth = visited[node]
            order.append((node, depth))
            if depth < max_depth:
                for neighbor in graph.get(node, []):
                    if neighbor not in visited:
                        visited[neighbor] = depth + 1
                        queue.append(neighbor)

        return order


# ----------------------------------------------------------------------
# SKELETON EXTRACTOR
# ----------------------------------------------------------------------
class SkeletonExtractor:
    """
    Keeps structural lines (imports, signatures, docstrings, errors, calls)
    and a 3-line peek into each function body. Collapses the rest.
    """
    _IMPORT_RE = re.compile(r'^\s*(import|export|from|require|using|#include)\b')
    _DECL_RE = re.compile(
        r'^\s*(?:export\s+)?(?:async\s+)?(?:abstract\s+)?'
        r'(?:public\s+|private\s+|protected\s+|static\s+)?'
        r'(function|class|interface|type|enum|struct|trait|def|fn|func)\b'
    )
    _ASSIGN_RE = re.compile(r'^\s*(?:export\s+)?(?:const|let|var|type)\s+\w+\s*[:=]')
    _DOC_RE = re.compile(r'^\s*(//|#|/\*\*|\*|"""|\'\'\')')

    def __init__(self, body_peek: int = SKELETON_BODY_PEEK):
        self.body_peek = body_peek

    def extract(self, content: str, info: ModuleInfo) -> List[str]:
        lines = content.splitlines()
        keep = set()

        for i, line in enumerate(lines, 1):
            if self._IMPORT_RE.match(line):
                keep.add(i)

        for sym in info.symbols:
            keep.add(sym.line)
            for j in range(max(1, sym.line - 3), sym.line):
                if self._DOC_RE.match(lines[j - 1]):
                    keep.add(j)
            for j in range(sym.line + 1, min(sym.line + 1 + self.body_peek, sym.body_end + 1)):
                if j <= len(lines):
                    keep.add(j)

        for ln, _ in info.error_sites:
            keep.add(ln)
        for ln, _, _ in info.call_sites:
            keep.add(ln)

        result = []
        prev = None
        for i in sorted(keep):
            if i > len(lines):
                continue
            if prev is not None and i > prev + 1:
                result.append("    // ...")
            result.append(f"{i:4d}|{lines[i - 1].rstrip()}")
            prev = i

        return result


# ----------------------------------------------------------------------
# FULL CODE EXTRACTOR (for --include-code deep mode)
# ----------------------------------------------------------------------
class FullCodeExtractor:
    """
    Extracts full code bodies with debug annotations inline.
    Marks error sites, call sites, and symbol boundaries.
    """
    def __init__(self, max_lines: int = MAX_CODE_LINES):
        self.max_lines = max_lines

    def extract(self, content: str, info: ModuleInfo) -> List[str]:
        lines = content.splitlines()
        result = []

        # Build lookup sets for annotation
        error_lines = {ln for ln, _ in info.error_sites}
        call_lines = {ln for ln, _, _ in info.call_sites}
        symbol_starts = {sym.line for sym in info.symbols}
        symbol_ranges = [(sym.line, sym.body_end, sym.name, sym.kind) for sym in info.symbols if sym.body_end > sym.line]

        count = 0
        for i, raw in enumerate(lines, 1):
            if count >= self.max_lines:
                result.append(f"   ... ({len(lines) - i + 1} more lines)")
                break

            line = raw.rstrip()
            if not line:
                continue

            markers = []
            if i in symbol_starts:
                markers.append("▼")
            if i in error_lines:
                markers.append("!")
            if i in call_lines:
                markers.append("→")

            prefix = "".join(markers) if markers else " "
            result.append(f"{i:4d}|{prefix}|{line}")
            count += 1

        return result


# ----------------------------------------------------------------------
# RELEVANCE ENGINE
# ----------------------------------------------------------------------
class RelevanceEngine:
    def __init__(self, builder: GraphBuilder, entries: List[FileEntry]):
        self.builder = builder
        self.entries = entries
        self.entry_map = {e.rel: e for e in entries}
        self._build_indices()

    def _build_indices(self):
        self.symbol_index: Dict[str, List[str]] = defaultdict(list)
        self.error_index: Dict[str, List[str]] = defaultdict(list)
        for e in self.entries:
            if not e.info:
                continue
            for s in e.info.symbols:
                self.symbol_index[s.name].append(e.rel)
            for site in e.info.error_sites:
                self.error_index[site[1]].append(e.rel)

    def query(self, target: str, max_depth: int = 2, max_results: int = 12) -> List[Tuple[FileEntry, float, str]]:
        scores: Dict[str, float] = defaultdict(float)
        reasons: Dict[str, List[str]] = defaultdict(list)

        if target in self.entry_map:
            scores[target] += 3.0
            reasons[target].append("target")
            up = {n: d for n, d in self.builder.bfs(target, self.builder.forward, max_depth)}
            down = {n: d for n, d in self.builder.bfs(target, self.builder.reverse, max_depth)}
            for n, d in up.items():
                scores[n] += 1.5 / (d + 1)
                reasons[n].append(f"upstream(d={d})")
            for n, d in down.items():
                scores[n] += 1.0 / (d + 1)
                reasons[n].append(f"downstream(d={d})")

        kw = target.lower()
        for sym, rels in self.symbol_index.items():
            if kw in sym.lower():
                for rel in rels:
                    scores[rel] += 0.8
                    reasons[rel].append(f"symbol:{sym}")
        for err, rels in self.error_index.items():
            if kw in err.lower():
                for rel in rels:
                    scores[rel] += 0.6
                    reasons[rel].append(f"error:{err}")

        results = []
        for rel, score in sorted(scores.items(), key=lambda x: -x[1]):
            if len(results) >= max_results:
                break
            entry = self.entry_map.get(rel)
            if entry:
                results.append((entry, score, "; ".join(reasons[rel])))
        return results


# ----------------------------------------------------------------------
# SERIALIZER
# ----------------------------------------------------------------------
class ContextSerializer:
    def __init__(
        self,
        include_code: bool = False,
        symbol_lines: bool = False,
        compact: bool = True,
        skeleton: bool = True,
        max_symbols: int = DEFAULT_MAX_SYMBOLS,
        debug: bool = False,
    ):
        self.include_code = include_code
        self.symbol_lines = symbol_lines
        self.compact = compact
        self.skeleton = skeleton
        self.max_symbols = max_symbols
        self.debug = debug
        self._skel = SkeletonExtractor()
        self._full = FullCodeExtractor()

    def serialize_full(
        self,
        entries: List[FileEntry],
        builder: GraphBuilder,
        root: Path,
        ignores: Set[str],
    ) -> str:
        lines: List[str] = []
        lines.extend(self._meta(entries, root))
        lines.append("")
        lines.extend(self._graph(builder))
        lines.append("")

        sorted_all = builder.topological_sort(set(e.rel for e in entries))
        for rel in sorted_all:
            lines.extend(self._module(builder.entry_map[rel]))
            lines.append("")

        return "\n".join(lines)

    def serialize_trace(
        self,
        target: str,
        builder: GraphBuilder,
        trace_deps: bool,
        max_depth: int,
    ) -> str:
        lines = [f"T|{target}"]
        target_entry = builder.entry_map.get(target)
        if not target_entry:
            return f"E|File not found: {target}"

        if trace_deps:
            upstream = builder.bfs(target, builder.forward, max_depth)
            if len(upstream) > 1:
                lines.append(f"U|{len(upstream) - 1} deps (max {max_depth})")
                self._serialize_trace_section(lines, upstream, builder, target)
                lines.append("")

        lines.append("R|TARGET")
        lines.extend(self._module(target_entry))
        lines.append("")

        downstream = builder.bfs(target, builder.reverse, max_depth)
        if len(downstream) > 1:
            lines.append(f"D|{len(downstream) - 1} dependents (max {max_depth})")
            self._serialize_trace_section(lines, downstream, builder, target)

        return "\n".join(lines)

    def serialize_query(
        self,
        engine: RelevanceEngine,
        query: str,
        max_depth: int,
        max_results: int,
    ) -> str:
        lines = [f"Q|{query}"]
        results = engine.query(query, max_depth, max_results)
        if not results:
            lines.append("E|No relevant context found")
            return "\n".join(lines)

        for entry, score, reason in results:
            lines.append(f"@{entry.rel} [score={score:.2f}] ({reason})")
            lines.extend(self._module(entry))
            lines.append("")

        return "\n".join(lines)

    def _meta(self, entries: List[FileEntry], root: Path) -> List[str]:
        lines = []
        name, desc = root.name, ""
        for rf in READMES:
            rp = root / rf
            if rp.exists():
                try:
                    c = rp.read_text(errors="replace")
                    h = re.search(r"^#\s+(.+)", c, re.MULTILINE)
                    if h:
                        name = h.group(1).strip()
                    for line in c.splitlines():
                        line = line.strip()
                        if line and line[0] not in "#!<":
                            desc = line[:200]
                            break
                except Exception:
                    pass
                break

        lines.append(f"P|{name}")
        if desc:
            lines.append(f"D|{desc}")

        pj = root / "package.json"
        if pj.exists():
            try:
                with open(pj) as f:
                    pk = json.load(f)
                for dt in ("dependencies", "devDependencies"):
                    dp = pk.get(dt, {})
                    if dp:
                        prefix = "prod" if dt == "dependencies" else "dev"
                        items = sorted(dp.items())[:15]
                        deps = "|".join(f"{k}:{v}" for k, v in items)
                        lines.append(f"N|{prefix}|{deps}")
            except Exception:
                pass

        stats = {"f": 0, "n": 0, "c": 0, "t": 0, "e": 0}
        for entry in entries:
            stats["f"] += 1
            if entry.info and not entry.info.error:
                stats["n"] += len([s for s in entry.info.symbols if s.kind in ("function", "method")])
                stats["c"] += len([s for s in entry.info.symbols if s.kind == "class"])
                stats["t"] += len([s for s in entry.info.symbols if s.kind == "type"])
            else:
                stats["e"] += 1

        lines.append(f"S|f={stats['f']} n={stats['n']} c={stats['c']} t={stats['t']} e={stats['e']}")
        return lines

    def _graph(self, builder: GraphBuilder) -> List[str]:
        lines = ["G|"]
        for src in sorted(builder.forward.keys()):
            targets = sorted(set(builder.forward[src]))
            if targets:
                lines.append(f"{src}>{','.join(targets)}")
        return lines

    def _serialize_trace_section(
        self,
        lines: List[str],
        nodes: List[Tuple[str, int]],
        builder: GraphBuilder,
        exclude: str,
    ) -> None:
        seen = set()
        for rel, depth in nodes:
            if rel == exclude or rel in seen:
                continue
            seen.add(rel)
            entry = builder.entry_map.get(rel)
            if not entry:
                continue
            lines.append(f"[{depth}]")
            lines.extend(self._module(entry))
            lines.append("")

    def _module(self, entry: FileEntry) -> List[str]:
        lines = [f">{entry.rel}"]
        info = entry.info
        if info is None:
            return lines
        if info.error:
            lines.append(f"!{info.error}")
            return lines

        if info.summary:
            lines.append(f"#{info.summary[:180]}")

        if info.imports:
            imports = info.imports[:DEFAULT_MAX_IMPORTS]
            lines.append(f"i:{'|'.join(imports)}")
        if info.local_imports:
            lines.append(f"l:{'|'.join(info.local_imports[:DEFAULT_MAX_IMPORTS])}")
        if info.exports:
            lines.append(f"e:{'|'.join(info.exports)}")

        # Debug annotations
        if self.debug:
            if info.error_sites:
                for ln, err in info.error_sites[:20]:
                    lines.append(f"!:{ln}|{err}")
            if info.call_sites:
                for ln, caller, callee in info.call_sites[:30]:
                    lines.append(f"^:{ln}|{caller}|{callee}")

        # Symbols
        syms = [s for s in info.symbols if not s.name.startswith("_") or s.name in ("__init__", "__call__")]
        if len(syms) > self.max_symbols:
            syms = syms[: self.max_symbols]

        for sym in syms:
            lp = f":{sym.line}" if self.symbol_lines and sym.line > 0 else ""
            if sym.kind == "class":
                p = f"({sym.parent})" if sym.parent else ""
                i = f"[{sym.interfaces}]" if sym.interfaces else ""
                lines.append(f"c:{sym.name}{lp}{p}{i}")
            elif sym.kind in ("function", "method"):
                a = "|a" if sym.is_async else ""
                r = f":{sym.ret}" if sym.ret else ""
                lines.append(f"f:{sym.name}{lp}({sym.params}){r}{a}")
                if sym.docstring:
                    lines.append(f"  #{sym.docstring[:120]}")
                if self.debug:
                    if sym.throws:
                        lines.append(f"  !throws:{','.join(sym.throws)}")
                    if sym.catches:
                        lines.append(f"  !catches:{','.join(sym.catches)}")
                    if sym.calls:
                        lines.append(f"  >calls:{','.join(sym.calls[:10])}")
            elif sym.kind == "type":
                lines.append(f"t:{sym.name}{lp}")
            elif sym.kind == "const":
                r = f":{sym.ret}" if sym.ret else ""
                lines.append(f"k:{sym.name}{lp}{r}")

        # CODE BLOCKS
        if self.include_code and entry.content:
            lines.append("---")
            if self.skeleton:
                skel = self._skel.extract(entry.content, info)
                lines.extend(skel)
            else:
                full = self._full.extract(entry.content, info)
                lines.extend(full)
            lines.append("---")

        return lines


# ----------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="LLM Context Generator v5.1")
    p.add_argument("project", nargs="?", default=".")
    p.add_argument("-o", "--output", default="project.txt")
    p.add_argument("-i", "--ignore", nargs="*", default=[])
    p.add_argument("--include-code", action="store_true", help="Include full code with debug annotations")
    p.add_argument("--symbol-lines", action="store_true")
    p.add_argument("--trace", type=str, help="Target file for impact analysis")
    p.add_argument("--trace-deps", action="store_true")
    p.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    p.add_argument("-j", "--jobs", type=int, default=None)
    p.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    p.add_argument("--include-vendor", action="store_true")
    p.add_argument("--debug", action="store_true", help="Include error traces and call graphs")
    p.add_argument("--query", type=str, help="Retrieve relevant context for a keyword/issue")
    p.add_argument("--compact", action="store_true", default=True)
    p.add_argument("--no-compact", action="store_false", dest="compact")
    p.add_argument("--skeleton", action="store_true", default=True, help="Skeleton mode (default). Use --no-skeleton for full bodies")
    p.add_argument("--no-skeleton", action="store_false", dest="skeleton")
    p.add_argument("--max-symbols", type=int, default=DEFAULT_MAX_SYMBOLS)
    a = p.parse_args()

    root = Path(a.project).resolve()
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        sys.exit(1)

    trace_target = None
    if a.trace:
        trace_path = Path(a.trace)
        try:
            trace_target = str((root / trace_path).relative_to(root))
        except ValueError:
            print(f"Error: {a.trace} is outside project root", file=sys.stderr)
            sys.exit(1)

    scanner = ProjectScanner(root, set(a.ignore), a.max_files, a.include_vendor)
    entries = scanner.scan()

    registry = ParserRegistry()
    max_workers = a.jobs or min(32, (os.cpu_count() or 1) + 4)

    def parse_entry(entry: FileEntry):
        if entry.size > MAX_FILE_SIZE:
            entry.info = ModuleInfo(path=entry.rel, error="Skipped (too large)")
            return
        try:
            entry.content = entry.path.read_text(encoding="utf-8", errors="replace")
            parser = registry.get(entry.rel)
            if parser is None:
                entry.info = ModuleInfo(path=entry.rel, content=entry.content, summary="")
                return
            entry.info = parser.parse(entry.content)
            entry.info.path = entry.rel
        except Exception as e:
            entry.info = ModuleInfo(path=entry.rel, error=str(e))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        list(executor.map(parse_entry, entries))

    builder = GraphBuilder(root, entries)
    builder.build()

    for entry in entries:
        if entry.info and not entry.info.error:
            local_specs = []
            for imp in entry.info.imports:
                resolved = builder._resolve_local(entry.rel, imp)
                if resolved:
                    local_specs.append(imp)
            entry.info.local_imports = local_specs
            entry.info.imports = [i for i in entry.info.imports if i not in local_specs]

    serializer = ContextSerializer(
        include_code=a.include_code,
        symbol_lines=a.symbol_lines,
        compact=a.compact,
        skeleton=a.skeleton,
        max_symbols=a.max_symbols,
        debug=a.debug,
    )

    if a.query:
        engine = RelevanceEngine(builder, entries)
        output = serializer.serialize_query(engine, a.query, a.max_depth, max_results=12)
    elif trace_target:
        output = serializer.serialize_trace(trace_target, builder, a.trace_deps, a.max_depth)
    else:
        output = serializer.serialize_full(entries, builder, root, scanner.ignores)

    output_path = Path(a.output)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(output)

    size = output_path.stat().st_size
    print(f"✅ {output_path} ({size:,} bytes ~{size//4:,} tok)")


if __name__ == "__main__":
    main()