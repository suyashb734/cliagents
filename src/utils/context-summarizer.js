/**
 * Context Summarizer
 *
 * Prevents context bloat in multi-agent workflows by summarizing agent outputs
 * before passing them to the next agent.
 *
 * Key insight from research: LLMs perform WORSE with irrelevant context.
 * Multi-agent systems see exponential token growth without summarization.
 */

/**
 * Summarize agent output using simple extraction rules.
 * For production, could integrate with a fast model (Haiku) for better summaries.
 *
 * @param {string} output - Raw agent output
 * @param {Object} options - Summarization options
 * @param {number} options.maxLength - Maximum summary length (default: 2000 chars)
 * @param {string} options.mode - 'extract' | 'truncate' | 'smart' (default: 'smart')
 * @param {string} options.taskType - Task type hint for better extraction
 * @returns {Object} - { summary: string, wasReduced: boolean, originalLength: number }
 */
function summarizeOutput(output, options = {}) {
  const {
    maxLength = 2000,
    mode = 'smart',
    taskType = null
  } = options;

  const originalLength = output.length;

  // If already under limit, no summarization needed
  if (output.length <= maxLength) {
    return {
      summary: output,
      wasReduced: false,
      originalLength
    };
  }

  let summary;

  switch (mode) {
    case 'truncate':
      summary = truncateOutput(output, maxLength);
      break;

    case 'extract':
      summary = extractKeyContent(output, maxLength, taskType);
      break;

    case 'smart':
    default:
      // Try extraction first, fall back to truncation
      summary = extractKeyContent(output, maxLength, taskType);
      if (summary.length > maxLength) {
        summary = truncateOutput(summary, maxLength);
      }
      break;
  }

  return {
    summary,
    wasReduced: true,
    originalLength,
    reductionRatio: ((originalLength - summary.length) / originalLength * 100).toFixed(1) + '%'
  };
}

/**
 * Simple truncation with ellipsis and context indicators
 */
function truncateOutput(output, maxLength) {
  // Reserve space for truncation indicator
  const reservedLength = 50;
  const effectiveMax = maxLength - reservedLength;

  // Try to truncate at a natural break point
  const truncated = output.slice(0, effectiveMax);
  const lastNewline = truncated.lastIndexOf('\n');
  const lastPeriod = truncated.lastIndexOf('. ');

  let breakPoint = effectiveMax;
  if (lastNewline > effectiveMax * 0.8) {
    breakPoint = lastNewline;
  } else if (lastPeriod > effectiveMax * 0.8) {
    breakPoint = lastPeriod + 1;
  }

  return truncated.slice(0, breakPoint) + '\n\n[... truncated, ' + (output.length - breakPoint) + ' more chars ...]';
}

/**
 * Extract key content based on patterns common in agent output
 */
function extractKeyContent(output, maxLength, taskType) {
  const sections = [];

  // Extract based on task type
  switch (taskType) {
    case 'review-bugs':
    case 'review-security':
    case 'review-performance':
      sections.push(...extractReviewFindings(output));
      break;

    case 'plan':
      sections.push(...extractPlanSections(output));
      break;

    case 'implement':
      sections.push(...extractImplementationSummary(output));
      break;

    case 'test':
      sections.push(...extractTestResults(output));
      break;

    default:
      // Generic extraction
      sections.push(...extractGenericContent(output));
      break;
  }

  // Combine sections up to maxLength
  let result = '';
  for (const section of sections) {
    if (result.length + section.length + 2 > maxLength) {
      break;
    }
    result += (result ? '\n\n' : '') + section;
  }

  return result || truncateOutput(output, maxLength);
}

/**
 * Extract findings from code review output
 */
function extractReviewFindings(output) {
  const sections = [];

  // Look for common review patterns
  const patterns = [
    /## (?:Issues?|Findings?|Bugs?|Vulnerabilities?|Problems?)[\s\S]*?(?=##|$)/gi,
    /\*\*(?:Critical|High|Medium|Low|Warning|Error)[\s\S]*?(?=\*\*|$)/gi,
    /(?:Found|Detected|Identified)[\s\S]*?(?:\n\n|$)/gi,
    /(?:\d+\.|-).*(?:bug|issue|vulnerability|problem|error).*(?:\n|$)/gi
  ];

  for (const pattern of patterns) {
    const matches = output.match(pattern);
    if (matches) {
      sections.push(...matches);
    }
  }

  // Extract summary sections
  const summaryMatch = output.match(/## (?:Summary|Conclusion|Recommendations?)[\s\S]*?(?=##|$)/i);
  if (summaryMatch) {
    sections.push(summaryMatch[0]);
  }

  return sections.length > 0 ? sections : [output.slice(0, 2000)];
}

/**
 * Extract plan sections
 */
function extractPlanSections(output) {
  const sections = [];

  // Look for plan structure
  const planPatterns = [
    /## (?:Plan|Steps|Tasks|Implementation|Approach)[\s\S]*?(?=##|$)/gi,
    /(?:\d+\.).*(?:\n(?:  .*)?)+/g, // Numbered lists with indented content
    /### .*[\s\S]*?(?=###|$)/gi
  ];

  for (const pattern of planPatterns) {
    const matches = output.match(pattern);
    if (matches) {
      sections.push(...matches);
    }
  }

  return sections.length > 0 ? sections : [output.slice(0, 2000)];
}

/**
 * Extract implementation summary
 */
function extractImplementationSummary(output) {
  const sections = [];

  // Look for file changes
  const fileChanges = output.match(/(?:Created|Modified|Updated|Added|Deleted).*?\.(?:js|ts|py|go|rs|java|json|yaml|yml|md).*(?:\n|$)/gi);
  if (fileChanges) {
    sections.push('Files changed:\n' + fileChanges.join('\n'));
  }

  // Look for completion indicators
  const completionPatterns = [
    /(?:Done|Complete|Finished|Success)[\s\S]{0,200}/gi,
    /## (?:Changes|Summary)[\s\S]*?(?=##|$)/gi
  ];

  for (const pattern of completionPatterns) {
    const matches = output.match(pattern);
    if (matches) {
      sections.push(...matches);
    }
  }

  return sections.length > 0 ? sections : [output.slice(0, 2000)];
}

/**
 * Extract test results
 */
function extractTestResults(output) {
  const sections = [];

  // Test result patterns
  const testPatterns = [
    /(?:PASS|FAIL|ERROR|SKIP).*(?:\n|$)/gi,
    /(?:\d+\s+(?:passed|failed|skipped|pending)).*(?:\n|$)/gi,
    /(?:Test|Spec).*(?:passed|failed).*(?:\n|$)/gi,
    /(?:✓|✗|⚠|✘).*(?:\n|$)/g
  ];

  for (const pattern of testPatterns) {
    const matches = output.match(pattern);
    if (matches) {
      sections.push(...matches);
    }
  }

  // Look for summary
  const summaryMatch = output.match(/(?:Test Suites?|Tests?):\s*\d+.*(?:\n.*)*?(?:\n\n|$)/i);
  if (summaryMatch) {
    sections.push(summaryMatch[0]);
  }

  return sections.length > 0 ? sections : [output.slice(0, 2000)];
}

/**
 * Generic content extraction
 */
function extractGenericContent(output) {
  const sections = [];

  // Look for headers and their content
  const headerMatches = output.match(/(?:##|###).*[\s\S]*?(?=##|###|$)/g);
  if (headerMatches) {
    // Prioritize shorter sections (likely more summary-like)
    headerMatches.sort((a, b) => a.length - b.length);
    sections.push(...headerMatches.slice(0, 3));
  }

  // Look for conclusions/summaries
  const conclusionPatterns = [
    /(?:In summary|To summarize|In conclusion|Overall)[\s\S]{0,500}/gi,
    /(?:Key (?:points?|findings?|takeaways?))[\s\S]*?(?=\n\n|$)/gi
  ];

  for (const pattern of conclusionPatterns) {
    const matches = output.match(pattern);
    if (matches) {
      sections.push(...matches);
    }
  }

  return sections;
}

/**
 * Create a context-aware summary for handoff between agents
 *
 * @param {string} output - Agent output
 * @param {Object} options - Options
 * @param {string} options.fromProfile - Source agent profile
 * @param {string} options.toProfile - Target agent profile
 * @param {string} options.taskType - Task type
 * @param {number} options.maxLength - Max summary length
 * @returns {string} - Formatted summary for next agent
 */
function createHandoffSummary(output, options = {}) {
  const {
    fromProfile = 'agent',
    toProfile = null,
    taskType = null,
    maxLength = 2000
  } = options;

  const result = summarizeOutput(output, { maxLength, taskType });

  let header = `## Results from ${fromProfile}`;
  if (result.wasReduced) {
    header += ` (summarized, ${result.reductionRatio} reduction)`;
  }

  let summary = header + '\n\n' + result.summary;

  // Add transition instruction if target is known
  if (toProfile) {
    const transition = getTransitionInstruction(fromProfile, toProfile, taskType);
    if (transition) {
      summary += '\n\n---\n' + transition;
    }
  }

  return summary;
}

/**
 * Get transition instruction between agents
 */
function getTransitionInstruction(fromProfile, toProfile, taskType) {
  const transitions = {
    'planner:implementer': 'Implement the plan above. Focus on the specific files and changes outlined.',
    'implementer:reviewer-bugs': 'Review the implementation for bugs and logic errors.',
    'implementer:reviewer-security': 'Review the implementation for security vulnerabilities.',
    'implementer:reviewer-performance': 'Review the implementation for performance issues.',
    'implementer:tester': 'Write and run tests for the implementation above.',
    'reviewer-bugs:fixer': 'Fix the bugs identified in the review above.',
    'reviewer-security:fixer': 'Fix the security issues identified above.',
    'reviewer-performance:fixer': 'Apply the performance optimizations suggested above.',
    'tester:fixer': 'Fix the failing tests identified above.'
  };

  const key = `${fromProfile}:${toProfile}`;
  return transitions[key] || null;
}

/**
 * Extract key decisions from agent output
 * Looks for decision-related patterns like "decided", "chose", "using", etc.
 *
 * @param {string} output - Agent output
 * @returns {Array<string>} - List of key decisions
 */
function extractKeyDecisions(output) {
  const decisions = [];

  // Look for "Key Decisions" or "Decisions" section with numbered/bulleted items
  // Match section headers with or without markdown formatting
  const decisionSectionMatch = output.match(/(?:##?\s*)?(?:Key\s+)?Decisions?\s*\n([\s\S]*?)(?=\n\s*(?:---|##|TODO|Note|$))/i);
  if (decisionSectionMatch) {
    // Extract numbered items (1. Item: Description or 1. Description)
    const numberedItems = decisionSectionMatch[1].match(/\d+\.\s*([^\n]+)/g);
    if (numberedItems) {
      for (const item of numberedItems) {
        const cleaned = item.replace(/^\d+\.\s*/, '').trim();
        if (cleaned.length >= 5 && !decisions.includes(cleaned)) {
          decisions.push(cleaned);
        }
      }
    }
    // Also check for bullet items
    const bulletItems = decisionSectionMatch[1].match(/[•\-\*]\s*([^\n]+)/g);
    if (bulletItems) {
      for (const item of bulletItems) {
        const cleaned = item.replace(/^[•\-\*]\s*/, '').trim();
        if (cleaned.length >= 5 && !decisions.includes(cleaned)) {
          decisions.push(cleaned);
        }
      }
    }
  }

  // If no section found, look for inline decision patterns
  if (decisions.length === 0) {
    const patterns = [
      /(?:decided|chose|chosen|selected|opted|using|will use|going with)\s+(?:to\s+)?(.{10,100}?)(?:\.|$)/gi,
      /(?:approach|strategy|solution)(?:\s+is)?:\s*(.{10,150}?)(?:\.|$)/gi,
      /(?:key decision|decision made):\s*(.{10,150}?)(?:\.|$)/gi
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        const decision = match[1] || match[0];
        const cleaned = decision.trim().replace(/^[•\-\*]\s*/, '');
        if (cleaned.length >= 10 && cleaned.length <= 200 && !decisions.includes(cleaned)) {
          decisions.push(cleaned);
        }
      }
    }
  }

  // Limit to top 5 most relevant decisions
  return decisions.slice(0, 5);
}

/**
 * Extract pending items from agent output
 * Looks for TODOs, future work, remaining tasks, etc.
 *
 * @param {string} output - Agent output
 * @returns {Array<string>} - List of pending items
 */
function extractPendingItems(output) {
  const pending = [];

  // Look for "TODO Items" or similar sections
  // Handle table format: "#: N\nTask: description"
  const todoSectionMatch = output.match(/(?:##?\s*)?(?:TODO|Pending|Remaining|Next\s+Steps?)(?:\s+Items?)?:?\s*\n([\s\S]*?)(?=\n\s*(?:---|##|Note|$))/i);
  if (todoSectionMatch) {
    // Look for "Task:" entries (table format)
    const taskMatches = todoSectionMatch[1].match(/Task:\s*([^\n]+)/gi);
    if (taskMatches) {
      for (const task of taskMatches) {
        const cleaned = task.replace(/^Task:\s*/i, '').trim();
        if (cleaned.length >= 3 && !pending.includes(cleaned)) {
          pending.push(cleaned);
        }
      }
    }

    // Also check for numbered/bulleted items
    const numberedItems = todoSectionMatch[1].match(/\d+\.\s*([^\n]+)/g);
    if (numberedItems) {
      for (const item of numberedItems) {
        const cleaned = item.replace(/^\d+\.\s*/, '').trim();
        if (cleaned.length >= 5 && !pending.includes(cleaned)) {
          pending.push(cleaned);
        }
      }
    }

    const bulletItems = todoSectionMatch[1].match(/[•\-\*]\s*([^\n]+)/g);
    if (bulletItems) {
      for (const item of bulletItems) {
        const cleaned = item.replace(/^[•\-\*]\s*/, '').trim();
        if (cleaned.length >= 5 && !pending.includes(cleaned)) {
          pending.push(cleaned);
        }
      }
    }
  }

  // If no section found, look for inline patterns
  if (pending.length === 0) {
    const patterns = [
      /(?:TODO|FIXME|HACK|XXX):\s*(.{10,150}?)(?:\n|$)/gi,
      /(?:remaining|left to do|still need|needs? to be|should be|must be)\s+(.{10,100}?)(?:\.|$)/gi,
      /(?:future work|next steps?|follow[- ]?up):\s*(.{10,150}?)(?:\n|$)/gi
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        const item = match[1] || match[0];
        const cleaned = item.trim().replace(/^[•\-\*]\s*/, '');
        if (cleaned.length >= 10 && cleaned.length <= 200 && !pending.includes(cleaned)) {
          pending.push(cleaned);
        }
      }
    }
  }

  // Limit to top 7 most relevant items
  return pending.slice(0, 7);
}

module.exports = {
  summarizeOutput,
  createHandoffSummary,
  truncateOutput,
  extractKeyContent,
  extractKeyDecisions,
  extractPendingItems
};
