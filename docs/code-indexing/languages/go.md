# Go Indexing

[← Back to Code Indexing Overview](../README.md)

## Overview

GitNexus indexes Go source files (`.go`) using **tree-sitter-go**. Go's type system is intentionally minimal -- no classes, no inheritance, no generics-era complexity at the AST level. The extraction focuses on functions, methods (with receiver types), structs, interfaces, imports, and Go's unique "inheritance" mechanism: struct embedding.

| Property | Value |
|----------|-------|
| Parser | `tree-sitter-go` |
| Extensions | `.go` |
| Query constant | `GO_QUERIES` |
| Node types | Function, Method, Struct, Interface |

## What Gets Extracted

### Definitions (Graph Nodes)

Each captured definition becomes a node in the knowledge graph with a `DEFINES` edge from the enclosing `File` node.

| Go Construct | Query Pattern | Graph Node Label |
|-------------|--------------|-----------------|
| `func main()` | `function_declaration` | **Function** |
| `func (s *Server) Start()` | `method_declaration` | **Method** |
| `type User struct { ... }` | `type_spec` with `struct_type` | **Struct** |
| `type Reader interface { ... }` | `type_spec` with `interface_type` | **Interface** |

**Key distinction:** Functions use `identifier` for their name, but methods use `field_identifier`. This is because Go methods are declared with a receiver parameter (`func (s *Server) Start()`), and tree-sitter-go represents the method name as a `field_identifier` rather than a plain `identifier`.

### Imports (IMPORTS edges)

Go import declarations are captured in both single and grouped forms.

| Go Syntax | Query Pattern |
|-----------|--------------|
| `import "fmt"` | `import_spec` with `interpreted_string_literal` |
| `import ( "fmt" ; "os" )` | `import_spec_list` containing multiple `import_spec` entries |

The import path includes the quotes in the raw capture (e.g., `"fmt"`). The linking phase strips the quotes before resolving.

Aliased imports (`import f "fmt"`) and dot imports (`import . "testing"`) use the same `import_spec` node -- the path is captured regardless of the alias.

### Calls (CALLS edges)

| Go Syntax | Query Pattern | What is captured |
|-----------|--------------|-----------------|
| `fmt.Println("hello")` | `selector_expression` with `field_identifier` | `Println` (the selected method) |
| `process(data)` | `call_expression` with `identifier` | `process` (direct call) |
| `User{Name: "Alice"}` | `composite_literal` with `type_identifier` | `User` (struct construction) |

The struct literal form (`User{Name: "Alice"}`) is captured as a constructor-like call. This is important because struct initialization is the Go equivalent of constructor invocation and creates a dependency on the struct type.

### Inheritance (EXTENDS edges)

Go has no traditional inheritance. Instead, struct embedding provides type composition:

```go
type Server struct {
    http.Handler    // embedded (anonymous) field
    Name string     // named field -- NOT captured
}
```

The query captures **anonymous fields** (fields declared with only a type and no field name) as heritage relationships:

| Go Syntax | Query Pattern | Edge Type |
|-----------|--------------|----------|
| `type Server struct { Handler }` | `field_declaration` with anonymous `type_identifier` | **EXTENDS** |

> **Caveat:** The heritage query captures all anonymous fields in a struct, including those that are not from embedded types but are simple unnamed fields. In practice, Go convention uses anonymous fields almost exclusively for embedding, so the false-positive rate is low.

## Annotated Example

Consider the following Go file `server/server.go`:

```go
package server

import (
    "fmt"                          // (1) grouped import
    "net/http"                     // (2) grouped import
)

type Handler interface {           // (3) interface
    ServeHTTP(w http.ResponseWriter, r *http.Request)
}

type Server struct {               // (4) struct + embedding
    Handler                        // (5) embedded field -> EXTENDS
    Port int
}

func NewServer(port int) *Server { // (6) function (constructor pattern)
    srv := Server{Port: port}      // (7) struct literal -> call
    fmt.Println("created")         // (8) member call
    return &srv
}

func (s *Server) Start() error {   // (9) method with receiver
    return http.ListenAndServe(    // (10) member call
        fmt.Sprintf(":%d", s.Port),
        s,
    )
}
```

The extraction pipeline produces the following graph:

```mermaid
graph TD
    FILE["File<br/>server/server.go"]

    INTF["Interface<br/>Handler"]
    STRC["Struct<br/>Server"]
    FUNC["Function<br/>NewServer"]
    MTHD["Method<br/>Start"]

    FILE -- DEFINES --> INTF
    FILE -- DEFINES --> STRC
    FILE -- DEFINES --> FUNC
    FILE -- DEFINES --> MTHD

    STRC -. EXTENDS .-> INTF

    FUNC -. CALLS .-> SRV_LIT["Server (literal)"]
    FUNC -. CALLS .-> PRINTLN["Println"]

    MTHD -. CALLS .-> LISTEN["ListenAndServe"]
    MTHD -. CALLS .-> SPRINTF["Sprintf"]

    FILE -. IMPORTS .-> FMT['"fmt"']
    FILE -. IMPORTS .-> HTTP['"net/http"']

    style FILE fill:#2d3748,color:#fff
    style INTF fill:#805ad5,color:#fff
    style STRC fill:#2b6cb0,color:#fff
    style FUNC fill:#38a169,color:#fff
    style MTHD fill:#38a169,color:#fff
    style SRV_LIT fill:#718096,color:#fff
    style PRINTLN fill:#718096,color:#fff
    style LISTEN fill:#718096,color:#fff
    style SPRINTF fill:#718096,color:#fff
```

**Solid edges** represent in-file relationships established during parsing. **Dashed edges** are resolved during the cross-file linking phase.

## Extraction Details

### Methods vs. Functions

Go distinguishes functions from methods purely by the presence of a receiver parameter:

```go
func Free()              {}   // Function  -- identifier "Free"
func (s *Srv) Bound()    {}   // Method    -- field_identifier "Bound"
```

In tree-sitter-go, the method name is a `field_identifier`, not an `identifier`. This is a grammar-level distinction, not a naming convention. The queries use separate patterns for each:

```
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
```

Methods are linked to their receiver struct via the `HAS_METHOD` edge if the enclosing type can be resolved from the AST.

### Struct Embedding as Heritage

Go's struct embedding is the idiomatic way to achieve composition (and, informally, "inheritance"). The heritage query targets the specific AST shape of an anonymous field:

```
(type_declaration
  (type_spec
    name: (type_identifier) @heritage.class
    type: (struct_type
      (field_declaration_list
        (field_declaration
          type: (type_identifier) @heritage.extends)))))
```

This only matches `field_declaration` nodes with a `type` child but no explicit `name` child -- i.e., anonymous fields. Named fields like `Port int` have a `(field_identifier)` child that prevents the match.

**Qualified embedded types** (e.g., `http.Handler`) use a `qualified_type` node rather than a `type_identifier`, so they are not captured by the current query. This is a known limitation.

### Composite Literals as Constructor Calls

Go has no `new` keyword for structs (except `new(T)` which returns a zero-value pointer). The idiomatic way to construct a struct is via a composite literal:

```go
user := User{Name: "Alice", Age: 30}
```

This is captured as a call to `User`:

```
(composite_literal type: (type_identifier) @call.name) @call
```

This creates a `CALLS` edge from the enclosing function to `User`, correctly modeling the construction dependency.

### Package-Level Scope

Go does not have file-level namespaces in the same way as C# or Java. The `package` declaration is not captured as a `Namespace` node because all files in the same directory share the same package. Package-level grouping is handled by GitNexus's folder-based heuristics during clustering, not by the tree-sitter queries.

## Node Type Matrix

| Definition Capture Key | Graph Node Label | Multiple per file? | Typical Go pattern |
|----------------------|-----------------|-------------------|--------------------|
| `definition.function` | Function | Yes | `func Foo()` -- top-level and exported functions |
| `definition.method` | Method | Yes | `func (r *Recv) Foo()` -- receiver methods |
| `definition.struct` | Struct | Yes | `type Foo struct { ... }` |
| `definition.interface` | Interface | Yes | `type Foo interface { ... }` |
