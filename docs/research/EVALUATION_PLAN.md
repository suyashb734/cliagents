# CLI Wrapper vs Direct API: Evaluation Plan

## Executive Summary

This document evaluates the **cliagents** CLI wrapper approach against direct API key usage for Claude, Gemini, and other LLMs. We analyze capabilities, limitations, and design benchmarks to measure real-world performance.

---

## Part 1: Capability Comparison

### What CLI Wrappers Provide (Built-in)

| Capability | Claude Code | Gemini CLI | Amazon Q | Copilot |
|------------|-------------|------------|----------|---------|
| File Read/Write | ✅ | ✅ | ✅ | ✅ |
| Code Execution | ✅ | ✅ | ✅ | ✅ |
| Shell Commands | ✅ | ✅ | ✅ | ✅ |
| Web Search | ✅ | ✅ | ❌ | ✅ |
| Git Operations | ✅ | ✅ | ✅ | ✅ |
| Multi-file Editing | ✅ | ✅ | ✅ | ✅ |
| Project Context | ✅ | ✅ | ✅ | ✅ |
| MCP Servers | ✅ | ❌ | ❌ | ❌ |
| Image Analysis | ✅ | ✅ | ❌ | ✅ |

### What Direct API Provides

| Capability | Claude API | Gemini API | Notes |
|------------|------------|------------|-------|
| Raw Text Generation | ✅ | ✅ | Core capability |
| Streaming | ✅ | ✅ | SSE-based |
| Tool Use | ✅ | ✅ | Must define tools yourself |
| Vision | ✅ | ✅ | Image input |
| Function Calling | ✅ | ✅ | Schema-based |
| System Prompts | ✅ | ✅ | Full control |
| Temperature/TopP | ✅ | ✅ | Fine-grained control |
| Token Counting | ✅ | ✅ | Precise usage tracking |
| Batch Processing | ✅ | ✅ | Bulk operations |
| Caching | ✅ | ❌ | Claude prompt caching |

---

## Part 2: Key Differences

### 1. Authentication & Cost

| Aspect | CLI Wrapper | Direct API |
|--------|-------------|------------|
| Auth Method | CLI login (OAuth/SSO) | API key |
| Billing | Subscription or per-seat | Per-token usage |
| Cost Tracking | Limited visibility | Detailed per-request |
| Rate Limits | CLI-imposed | API tier based |

### 2. Control & Flexibility

| Aspect | CLI Wrapper | Direct API |
|--------|-------------|------------|
| Model Selection | Limited to CLI options | Full model access |
| Parameters | Fixed/limited | Full control |
| System Prompts | Prepended, not replaced | Complete control |
| Response Format | CLI-formatted output | Raw JSON |
| Tool Definition | Pre-built, not customizable | Fully customizable |
| Context Window | CLI-managed | Developer-managed |

### 3. Capabilities

| Aspect | CLI Wrapper | Direct API |
|--------|-------------|------------|
| File Operations | Built-in | Must implement |
| Code Execution | Sandboxed/built-in | Must implement safely |
| Web Access | Some built-in | Must implement |
| Agentic Loops | Built-in | Must implement |
| Error Recovery | CLI handles | Developer handles |

### 4. Integration

| Aspect | CLI Wrapper | Direct API |
|--------|-------------|------------|
| Setup Complexity | Install CLI + auth | API key only |
| Language Support | HTTP wrapper only | Native SDKs |
| Latency | CLI overhead | Direct connection |
| Offline | Not available | Not available |

---

## Part 3: Use Case Analysis

### When CLI Wrapper is Better

1. **Coding Tasks** - Built-in file operations, git, shell
2. **Quick Prototyping** - No tool implementation needed
3. **Subscription Users** - Already paying for Claude Pro/Teams
4. **Multi-model Flexibility** - Switch between Claude/Gemini easily
5. **Agentic Workflows** - Built-in reasoning loops
6. **Security-Conscious** - No API keys to manage/leak

### When Direct API is Better

1. **High Volume** - Per-token pricing more predictable
2. **Custom Tools** - Need specific tool implementations
3. **Fine Control** - Temperature, system prompts, parameters
4. **Production Apps** - Reliable SLAs, rate limits
5. **Non-Coding Tasks** - Chat, analysis, generation
6. **Integration** - Native SDK support, webhooks
7. **Cost Optimization** - Prompt caching, batching

---

## Part 4: Evaluation Framework

### Benchmark Categories

#### A. Code Generation Tasks

| Task | Metrics | CLI Advantage | API Advantage |
|------|---------|---------------|---------------|
| Write function | Correctness, time | Context awareness | Speed |
| Debug code | Fix rate, iterations | File access | Control |
| Refactor file | Quality, safety | Built-in edits | Batch |
| Multi-file change | Consistency | Built-in | Must implement |

#### B. Information Tasks

| Task | Metrics | CLI Advantage | API Advantage |
|------|---------|---------------|---------------|
| Answer question | Accuracy | Web search | Faster |
| Summarize doc | Quality | File read | Control |
| Research topic | Depth | Web + tools | Customizable |

#### C. Automation Tasks

| Task | Metrics | CLI Advantage | API Advantage |
|------|---------|---------------|---------------|
| Run tests | Pass rate | Shell access | None |
| Deploy code | Success | Git + shell | None |
| Manage files | Accuracy | Built-in | Must implement |

#### D. Production Scenarios

| Task | Metrics | CLI Advantage | API Advantage |
|------|---------|---------------|---------------|
| Handle 100 requests | Throughput | None | Rate limits, SLA |
| Track costs | Accuracy | None | Token tracking |
| Custom workflow | Flexibility | None | Full control |

---

## Part 5: Proposed Benchmarks

### Benchmark 1: Code Task Suite

```
Tasks:
1. Implement FizzBuzz in Python
2. Add error handling to existing function
3. Write unit tests for a class
4. Refactor callback to async/await
5. Fix 5 intentional bugs in a file

Metrics:
- Correctness (tests pass)
- Time to complete
- Number of iterations
- Token usage (API only)
```

### Benchmark 2: Multi-file Project

```
Tasks:
1. Add new API endpoint to Express app
2. Update 3 files for new feature
3. Run tests and fix failures
4. Generate documentation

Metrics:
- All tests pass
- Consistent code style
- Time to complete
- File operation count
```

### Benchmark 3: Research & Analysis

```
Tasks:
1. Summarize a technical document
2. Compare two code implementations
3. Generate report from data file
4. Answer questions about codebase

Metrics:
- Accuracy of output
- Completeness
- Time to complete
```

### Benchmark 4: Production Simulation

```
Tasks:
1. Process 50 similar requests
2. Handle errors gracefully
3. Track all operations
4. Report usage statistics

Metrics:
- Success rate
- Average latency
- Error recovery
- Resource usage
```

---

## Part 6: Limitations of CLI Approach

### Hard Limitations

1. **No Custom Tools** - Cannot define new tool schemas
2. **No System Prompt Override** - CLI controls the prompt
3. **No Token-Level Control** - Cannot set max_tokens precisely
4. **No Batch API** - One request at a time
5. **No Prompt Caching** - Cannot reuse context efficiently
6. **No Webhooks** - Must poll or stream
7. **Limited Models** - Only what CLI exposes
8. **No Embeddings** - CLI doesn't support embedding models

### Soft Limitations

1. **Latency** - CLI startup overhead
2. **Debugging** - Less visibility into model behavior
3. **Cost Tracking** - Indirect through subscription
4. **Rate Limits** - Less predictable
5. **Version Control** - CLI updates may break

---

## Part 7: Recommendations

### Use cliagents (CLI Wrapper) When:

- Building developer tools
- Prototyping agentic systems
- Already have CLI subscriptions
- Need file/shell operations out of the box
- Want multi-model flexibility without code changes
- Security policy prevents API key storage

### Use Direct API When:

- Building production applications
- Need precise cost control
- Require custom tool definitions
- Need maximum performance
- Building non-coding applications
- Need fine-grained parameter control

### Hybrid Approach

Consider using both:
- **CLI for development** - Fast iteration, built-in tools
- **API for production** - Reliability, cost control, SLAs

---

## Part 8: Implementation Roadmap

To make cliagents more competitive with direct API:

### Phase 1: Parity Features
- [ ] Add token usage estimation
- [ ] Add request timing metrics
- [ ] Add cost estimation per adapter
- [ ] Implement request queuing

### Phase 2: Enhanced Features
- [ ] Add caching layer for repeated prompts
- [ ] Add batch mode for multiple prompts
- [ ] Add webhook support for async results
- [ ] Add structured output parsing

### Phase 3: Production Ready
- [ ] Add health check endpoints
- [ ] Add rate limiting
- [ ] Add authentication for server
- [ ] Add Kubernetes deployment configs
- [ ] Add Prometheus metrics

---

## Conclusion

The CLI wrapper approach excels at **coding tasks** and **rapid prototyping** where built-in file operations, shell access, and agentic loops provide immediate value. Direct API access is superior for **production applications**, **custom workflows**, and scenarios requiring **fine-grained control**.

The cliagents project fills a valuable niche: exposing powerful CLI agents over HTTP for integration into development workflows, automation pipelines, and multi-agent systems. It is not a replacement for direct API access but a complement for specific use cases.
