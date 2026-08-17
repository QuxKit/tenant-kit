# tenant-kit — diagrams

The mermaid sources for this repo. They live here rather than in the
README because npm renders no mermaid: on the package page a fence
like this one ships as raw DSL. GitHub and the QuxKit docs site both
draw them. The README carries an ASCII equivalent of each.

## Request to tenant: extraction, authorization, context, isolation

```mermaid
flowchart LR
    req(["request"])

    subgraph TK["tenant-kit — Apache-2.0"]
        direction LR
        ex["extract<br/>claim, untrusted"]
        az["authorize<br/>directory + membership"]
        ctx["context<br/>ambient tenant"]
        iso["isolation<br/>RLS-scoped executor"]
        ex -->|TenantClaim| az
        az -->|ResolvedTenant| ctx
        ctx --> iso
    end

    subgraph HOST["your app"]
        h["handlers"]
        db[("your tables<br/>tenancy.protect()")]
    end

    req --> ex
    iso -->|"SET LOCAL, per txn"| db
    ctx --> h
    h --> iso

    classDef own fill:#0d9488,stroke:#0f766e,color:#ffffff;
    classDef host fill:#1e293b,stroke:#0f172a,color:#e2e8f0;
    class ex,az,ctx,iso own;
    class h,db host;
    class req host;
```
