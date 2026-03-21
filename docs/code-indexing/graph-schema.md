# Graph Schema Reference

GitNexus indexes source code into a typed knowledge graph stored in KuzuDB (default) or AWS Neptune. This document is the complete reference for the graph data model: every node type, every relationship type, and every property.

## Hybrid Schema Design

The schema uses a **hybrid approach**:

- **Separate node tables** for each code element type (`File`, `Function`, `Class`, `Method`, ...). This lets Cypher queries target specific types directly without label filtering.
- **A single `CodeRelation` relationship table** with a `type` property that discriminates `CALLS`, `DEFINES`, `IMPORTS`, etc. This avoids the combinatorial explosion of creating one REL TABLE per (source, target, type) triple.

A typical query therefore looks like:

```cypher
MATCH (f:Function)-[r:CodeRelation {type: 'CALLS'}]->(g:Function)
RETURN f.name, g.name, r.confidence
```

Node tables must be created before the relationship table that references them. The full creation order is defined in `SCHEMA_QUERIES` (see source).

**Source files:**
- [`gitnexus/src/core/kuzu/schema.ts`](../../gitnexus/src/core/kuzu/schema.ts) -- KuzuDB DDL definitions
- [`gitnexus/src/core/graph/types.ts`](../../gitnexus/src/core/graph/types.ts) -- TypeScript type definitions
- [`gitnexus/src/config/supported-languages.ts`](../../gitnexus/src/config/supported-languages.ts) -- Supported language enum

---

## Entity-Relationship Diagram

```mermaid
erDiagram
    Folder ||--o{ Folder : "CONTAINS"
    Folder ||--o{ File : "CONTAINS"
    File ||--o{ Function : "DEFINES"
    File ||--o{ Class : "DEFINES"
    File ||--o{ Interface : "DEFINES"
    File ||--o{ Method : "DEFINES"
    File ||--o{ Module : "DEFINES"
    File ||--o{ Struct : "DEFINES"
    File ||--o{ Enum : "DEFINES"
    File ||--o{ Record : "DEFINES"
    File ||--o{ Property : "DEFINES"
    File ||--o{ CodeElement : "DEFINES"
    File ||--o{ File : "IMPORTS"
    Class ||--o{ Method : "HAS_METHOD"
    Class ||--|{ Class : "EXTENDS"
    Class ||--|{ Interface : "IMPLEMENTS"
    Struct ||--|{ Trait : "IMPLEMENTS"
    Impl ||--o{ Method : "HAS_METHOD"
    Trait ||--o{ Method : "HAS_METHOD"
    Record ||--o{ Method : "HAS_METHOD"
    Record ||--o{ Property : "CONTAINS"
    Function ||--o{ Function : "CALLS"
    Method ||--o{ Method : "CALLS"
    Method ||--|{ Method : "OVERRIDES"
    Function }o--|| Community : "MEMBER_OF"
    Class }o--|| Community : "MEMBER_OF"
    Method }o--|| Community : "MEMBER_OF"
    Function }o--|| Process : "STEP_IN_PROCESS"
    Method }o--|| Process : "STEP_IN_PROCESS"
    Module ||--o{ Record : "CONTAINS"
    Module ||--o{ Property : "CONTAINS"
    Module ||--o{ CodeElement : "ACCESSES"
    Record ||--|{ Record : "REDEFINES"
    Property ||--|{ Property : "REDEFINES"

    File {
        STRING id PK
        STRING name
        STRING filePath
        STRING content
    }
    Folder {
        STRING id PK
        STRING name
        STRING filePath
    }
    Function {
        STRING id PK
        STRING name
        STRING filePath
        INT64 startLine
        INT64 endLine
        BOOLEAN isExported
        STRING content
        STRING description
    }
    Class {
        STRING id PK
        STRING name
        STRING filePath
        INT64 startLine
        INT64 endLine
        BOOLEAN isExported
        STRING content
        STRING description
    }
    Method {
        STRING id PK
        STRING name
        STRING filePath
        INT64 startLine
        INT64 endLine
        BOOLEAN isExported
        STRING content
        STRING description
        INT32 parameterCount
        STRING returnType
    }
    Community {
        STRING id PK
        STRING label
        STRING heuristicLabel
        STRING_ARRAY keywords
        STRING description
        STRING enrichedBy
        DOUBLE cohesion
        INT32 symbolCount
    }
    Process {
        STRING id PK
        STRING label
        STRING heuristicLabel
        STRING processType
        INT32 stepCount
        STRING_ARRAY communities
        STRING entryPointId
        STRING terminalId
    }
```

---

## Node Types

There are 27 node tables. The first 9 are **core types** present in every indexed codebase; the remaining 18 are **multi-language types** used by specific language parsers.

### Core Node Types

| Node Type | Description | Source Languages | Key Properties |
|-----------|-------------|------------------|----------------|
| **File** | Source file | All | `id`, `name`, `filePath`, `content` |
| **Folder** | Directory in the file tree | All | `id`, `name`, `filePath` |
| **Function** | Function or paragraph | All (paragraphs in COBOL) | `id`, `name`, `filePath`, `startLine`, `endLine`, `isExported`, `content`, `description` |
| **Class** | Class or object type | TS, JS, Java, C#, C++, Kotlin, PHP, Ruby, Swift, Python | `id`, `name`, `filePath`, `startLine`, `endLine`, `isExported`, `content`, `description` |
| **Interface** | Interface or protocol | TS, Java, C#, Go, Kotlin, Swift, PHP | `id`, `name`, `filePath`, `startLine`, `endLine`, `isExported`, `content`, `description` |
| **Method** | Method or member function | All languages with classes/structs | `id`, `name`, `filePath`, `startLine`, `endLine`, `isExported`, `content`, `description`, `parameterCount`, `returnType` |
| **CodeElement** | Generic fallback for unclassified symbols | All | `id`, `name`, `filePath`, `startLine`, `endLine`, `isExported`, `content`, `description` |
| **Community** | Leiden algorithm cluster | Pipeline-generated (not parsed from source) | `id`, `label`, `heuristicLabel`, `keywords`, `description`, `enrichedBy`, `cohesion`, `symbolCount` |
| **Process** | Detected execution flow | Pipeline-generated (not parsed from source) | `id`, `label`, `heuristicLabel`, `processType`, `stepCount`, `communities`, `entryPointId`, `terminalId` |

### Multi-Language Node Types

All multi-language node types share the same **base schema**: `id STRING`, `name STRING`, `filePath STRING`, `startLine INT64`, `endLine INT64`, `content STRING`, `description STRING`.

| Node Type | Description | Source Languages |
|-----------|-------------|------------------|
| **Struct** | Struct type | C, C++, Go, Rust, C#, Swift |
| **Enum** | Enumeration type | Java, C, C++, C#, Rust, Kotlin, Swift |
| **Macro** | Preprocessor macro | C, C++ |
| **Typedef** | Type definition | C, C++ |
| **Union** | Union type | C, C++ |
| **Namespace** | Namespace or COBOL section | C++, C#, PHP, COBOL (sections) |
| **Trait** | Trait or mixin | Rust, PHP |
| **Impl** | Implementation block | Rust |
| **TypeAlias** | Type alias | Rust, Kotlin, Swift |
| **Const** | Constant or COBOL 88-level condition | Rust, COBOL (88-level conditions) |
| **Static** | Static item | Rust |
| **Property** | Property or COBOL data item | C#, Kotlin, Swift, PHP, Ruby, COBOL (data items level 02-49, 66, 77) |
| **Record** | Record type or COBOL 01-level group | C#, COBOL (01-level data items) |
| **Delegate** | Delegate type | C# |
| **Annotation** | Annotation type | Java |
| **Constructor** | Constructor or COBOL ENTRY point | Java, C#, C++, COBOL (ENTRY points) |
| **Template** | Template | C++ |
| **Module** | Module or COBOL program | Rust, Ruby, COBOL (PROGRAM-ID) |

---

## Node Properties Reference

Properties vary by node type. The table below lists every property that can appear on a node in the graph.

| Property | Type | Description | Present On |
|----------|------|-------------|------------|
| `id` | `STRING` | Unique identifier (deterministic hash of filePath + name + line) | All node types |
| `name` | `STRING` | Symbol name (function name, class name, file name, etc.) | All node types |
| `filePath` | `STRING` | Relative file path from repository root | All node types |
| `content` | `STRING` | Source code snippet (truncated for large symbols) | File, Function, Class, Interface, Method, CodeElement, and all multi-language types |
| `startLine` | `INT64` | Start line number (0-indexed) | All code symbols (not File, Folder, Community, Process) |
| `endLine` | `INT64` | End line number (0-indexed) | All code symbols (not File, Folder, Community, Process) |
| `isExported` | `BOOLEAN` | Whether the symbol is exported/public | Function, Class, Interface, Method, CodeElement |
| `description` | `STRING` | Metadata, framework hints, or LLM-enriched description | Function, Class, Interface, Method, CodeElement, Community, and all multi-language types |
| `parameterCount` | `INT32` | Number of parameters (used for MRO disambiguation) | Method only |
| `returnType` | `STRING` | Return type text | Method only |
| `language` | `SupportedLanguages` | Source language enum value | All code symbols (in-memory `GraphNode` only; not persisted to KuzuDB) |
| `label` | `STRING` | Human-readable label | Community, Process |
| `heuristicLabel` | `STRING` | Auto-generated label from symbol names in the cluster/flow | Community, Process |
| `keywords` | `STRING[]` | Extracted keywords for the cluster | Community |
| `enrichedBy` | `STRING` | `'heuristic'` or `'llm'` -- how the label was generated | Community |
| `cohesion` | `DOUBLE` | Internal connectivity score (0.0-1.0) | Community |
| `symbolCount` | `INT32` | Number of symbols in the cluster | Community |
| `processType` | `STRING` | `'intra_community'` or `'cross_community'` | Process |
| `stepCount` | `INT32` | Number of steps in the execution flow | Process |
| `communities` | `STRING[]` | IDs of communities the flow passes through | Process |
| `entryPointId` | `STRING` | Node ID of the flow's entry point | Process |
| `terminalId` | `STRING` | Node ID of the flow's terminal point | Process |

**In-memory only properties** (present on `GraphNode.properties` but not stored in KuzuDB):

| Property | Type | Description |
|----------|------|-------------|
| `language` | `SupportedLanguages` | Enum: `javascript`, `typescript`, `python`, `java`, `c`, `cpp`, `csharp`, `go`, `ruby`, `rust`, `php`, `kotlin`, `swift`, `cobol` |
| `astFrameworkMultiplier` | `number` | Entry-point boost from framework annotations (e.g., `@Controller`) |
| `astFrameworkReason` | `string` | Which annotation triggered the boost |
| `entryPointScore` | `number` | Computed entry-point score for process detection |
| `entryPointReason` | `string` | Why this symbol was scored as an entry point |

---

## Relationship Types

All relationships are stored in a single `CodeRelation` relationship table. The `type` property discriminates the semantic meaning. The table is defined with explicit `FROM ... TO ...` pairs that enumerate every valid (source table, target table) combination.

### Core Relationship Types

| Type | Source -> Target | Meaning | Confidence | Notes |
|------|-----------------|---------|------------|-------|
| `CONTAINS` | Folder->File, Folder->Folder, Module->Record, CodeElement->Record, Namespace->Property, etc. | Structural containment | 1.0 | Hierarchical, models directory trees and symbol nesting |
| `DEFINES` | File->any symbol type | File defines this symbol | 1.0 | Always present for every code symbol |
| `IMPORTS` | File->File | Import, require, include, or COPY statement | Varies | Resolved via suffix matching across the file tree |
| `CALLS` | Function->Function, Method->Method, Constructor->Function, etc. | Function invocation, PERFORM, or CALL | 0.5-1.0 | Three resolution phases: import-resolved, same-file, fuzzy-global |
| `EXTENDS` | Class->Class, Struct->Struct, Enum->Class, etc. | Class/struct inheritance | 0.8-1.0 | |
| `IMPLEMENTS` | Class->Interface, Struct->Trait, Impl->Trait | Interface or trait implementation | 0.8-1.0 | |
| `HAS_METHOD` | Class->Method, Trait->Method, Impl->Method, Record->Method, etc. | Type owns this method | 1.0 | |
| `OVERRIDES` | Method->Method | Method resolution order (MRO) computed override | 1.0 | Computed by `computeMRO` pass |
| `MEMBER_OF` | any symbol->Community | Symbol belongs to a Leiden cluster | 1.0 | Created during community detection |
| `STEP_IN_PROCESS` | any symbol->Process | Symbol participates in an execution flow | 1.0 | `step` property is 1-indexed |

### COBOL-Specific Relationship Types

These types are produced exclusively by the COBOL deep-indexing pipeline.

| Type | Source -> Target | Meaning | Confidence | Notes |
|------|-----------------|---------|------------|-------|
| `REDEFINES` | Record->Record, Property->Property | COBOL REDEFINES clause | 1.0 | Links redefined data items to their targets |
| `RECORD_KEY_OF` | Property->CodeElement | COBOL RECORD KEY clause | 0.8 | Connects key fields to their file descriptors |
| `FILE_STATUS_OF` | Property->CodeElement | COBOL FILE STATUS clause | 0.8 | Connects status variables to their file descriptors |
| `ACCESSES` | Module->CodeElement | SQL table, CICS map, or cursor access | 0.9 | Tracks external resource usage |
| `RECEIVES` | Module->Property | PROCEDURE DIVISION USING parameter | 0.8 | Inter-program data contract |
| `DATA_FLOW` | (reserved) | MOVE data flow tracking | -- | Reserved for future use |
| `CONTRACTS` | Module->Module | Shared copybook contract between programs | 0.9 | Two programs that COPY the same copybook |

> **Note:** The `REL_TYPES` constant in `schema.ts` lists the 10 core types. COBOL-specific types are defined in the `RelationshipType` union in `types.ts` and stored in the same `CodeRelation` table using the `type` property.

---

## Relationship Properties

Every edge in the `CodeRelation` table carries these properties:

| Property | Type | Description |
|----------|------|-------------|
| `type` | `STRING` | Relationship type (one of the values from the tables above) |
| `confidence` | `DOUBLE` | Confidence score from 0.0 to 1.0. `1.0` = certain (e.g., same-file define). Lower values indicate fuzzy resolution. |
| `reason` | `STRING` | How the relationship was resolved. Common values: `'import-resolved'`, `'same-file'`, `'fuzzy-global'`, `'leiden-algorithm'`, `'trace-detection'`, `'mro-computed'`, or empty for structural relationships. |
| `step` | `INT32` | Step number within an execution flow. Only meaningful for `STEP_IN_PROCESS` relationships. 1-indexed. |

### Confidence Score Guidelines

| Score | Meaning | Example |
|-------|---------|---------|
| 1.0 | Certain | `DEFINES`, `HAS_METHOD`, `CONTAINS`, same-file `CALLS` |
| 0.8-0.9 | High confidence | Import-resolved `CALLS`, `EXTENDS` with resolved base class |
| 0.5-0.7 | Fuzzy match | Global name resolution `CALLS` (name match without import proof) |

---

## Embedding Table

Semantic search is powered by a separate node table that stores vector embeddings.

| Table | Schema | Index |
|-------|--------|-------|
| `CodeEmbedding` | `nodeId STRING (PK)`, `embedding FLOAT[384]` | HNSW vector index with cosine similarity |

- **Dimensions:** 384 (configurable via `getEmbeddingSchema(dims)`, defaults to 384)
- **Index name:** `code_embedding_idx`
- **Algorithm:** HNSW (Hierarchical Navigable Small World)
- **Metric:** Cosine similarity
- **Usage:** The `nodeId` foreign-keys back to any node table's `id`. Not all nodes have embeddings; typically functions, methods, and classes are embedded.

```cypher
-- Semantic search example
CALL vector_search('CodeEmbedding', 'code_embedding_idx', $queryVector, 10)
RETURN node.nodeId, node.score
```

> **Note:** Embeddings are not supported on AWS Neptune (v1). When using Neptune as the backend, the embedding step is skipped with a warning.

---

## Schema Creation Order

Node tables must exist before the relationship table that references them. The canonical creation order is:

1. **Core node tables** (9): File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process
2. **Multi-language node tables** (18): Struct, Enum, Macro, Typedef, Union, Namespace, Trait, Impl, TypeAlias, Const, Static, Property, Record, Delegate, Annotation, Constructor, Template, Module
3. **Relationship table** (1): CodeRelation
4. **Embedding table** (1): CodeEmbedding + HNSW index

This order is enforced by the `SCHEMA_QUERIES` array exported from `schema.ts`.

---

## Cypher Query Examples

**Find all functions that call a given function:**
```cypher
MATCH (caller:Function)-[r:CodeRelation {type: 'CALLS'}]->(target:Function {name: 'validateUser'})
RETURN caller.name, caller.filePath, r.confidence
ORDER BY r.confidence DESC
```

**Trace an execution flow step by step:**
```cypher
MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {label: 'auth-flow'})
RETURN r.step, labels(n)[1] AS nodeType, n.name, n.filePath
ORDER BY r.step
```

**Find all members of a community:**
```cypher
MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
WHERE c.heuristicLabel CONTAINS 'auth'
RETURN n.name, labels(n)[1] AS nodeType, c.heuristicLabel
```

**List class hierarchy:**
```cypher
MATCH (child:Class)-[r:CodeRelation {type: 'EXTENDS'}]->(parent:Class)
RETURN child.name, parent.name, r.confidence
```

**COBOL: Find all programs that access a given SQL table:**
```cypher
MATCH (m:Module)-[r:CodeRelation {type: 'ACCESSES'}]->(t:CodeElement {name: 'EMPLOYEE_TABLE'})
RETURN m.name, r.confidence
```

---

[Back to docs](../README.md)
