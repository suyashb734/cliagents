const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SkillsService, parseFrontmatter } = require('../src/services/skills-service');

async function testSkillsService() {
  console.log('Testing Skills Service (Updated)...');

  // 1. Test parseFrontmatter
  console.log('1. Testing parseFrontmatter...');
  const content = '---\nname: test-skill\ndescription: A test skill\ntags: [test, skill]\ncustom-key: custom value\n---\n# Body\nContent here';
  const parsed = parseFrontmatter(content);
  assert.strictEqual(parsed.frontmatter.name, 'test-skill');
  assert.strictEqual(parsed.frontmatter['custom-key'], 'custom value');
  console.log('   ✓ custom-key parsed correctly');

  // 2. Test SkillsService discovery (Sync)
  console.log('2. Testing SkillsService discovery (Sync)...');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  const projectRoot = path.join(tempDir, 'root');
  fs.mkdirSync(projectRoot);
  
  const coreDir = path.join(tempDir, 'core');
  const projectDirRelative = '.cliagents/skills';
  const projectDirAbsolute = path.join(projectRoot, projectDirRelative);
  
  fs.mkdirSync(coreDir);
  fs.mkdirSync(path.join(coreDir, 'skill-core'));
  fs.writeFileSync(path.join(coreDir, 'skill-core', 'SKILL.md'), '---\nname: skill-core\n---\nCore');

  fs.mkdirSync(path.dirname(projectDirAbsolute), { recursive: true });
  fs.mkdirSync(projectDirAbsolute);
  fs.mkdirSync(path.join(projectDirAbsolute, 'skill-project'));
  fs.writeFileSync(path.join(projectDirAbsolute, 'skill-project', 'SKILL.md'), '---\nname: skill-project\n---\nProject');

  const service = new SkillsService({
    coreDir: coreDir,
    projectRoot: projectRoot,
    projectDir: projectDirRelative,
    personalDir: path.join(tempDir, 'personal')
  });

  const allSkills = service.getAllSkills();
  assert.strictEqual(allSkills.length, 2);
  console.log('   ✓ Sync discovery works');

  // 3. Test SkillsService discovery (Async)
  console.log('3. Testing SkillsService discovery (Async)...');
  const allSkillsAsync = await service.getAllSkillsAsync();
  assert.strictEqual(allSkillsAsync.length, 2);
  
  const loadedAsync = await service.loadSkillAsync('skill-project');
  assert.strictEqual(loadedAsync.name, 'skill-project');
  assert.strictEqual(loadedAsync.content, 'Project');
  console.log('   ✓ Async discovery and loading works');

  // 4. Test Security (Path Traversal)
  console.log('4. Testing Security (Path Traversal)...');
  // Capture console.warn
  const originalWarn = console.warn;
  let warnCalled = false;
  console.warn = () => { warnCalled = true; };
  
  const insecureService = new SkillsService({
    projectRoot: projectRoot,
    projectDir: '../../../../etc'
  });
  
  console.warn = originalWarn;
  assert.strictEqual(warnCalled, true);
  assert.ok(insecureService.projectDir.startsWith(projectRoot));
  console.log('   ✓ Security path traversal blocked');

  // 5. Test search and tags
  console.log('5. Testing search and tags...');
  const searchResults = await service.searchSkillsAsync('project');
  assert.strictEqual(searchResults.length, 1);
  assert.strictEqual(searchResults[0].name, 'skill-project');
  
  const tags = await service.getAllTagsAsync();
  assert.ok(Array.isArray(tags));
  console.log('   ✓ Search and tags work');

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('All tests passed!');
}

testSkillsService().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
