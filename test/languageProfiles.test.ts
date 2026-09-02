import {
  blockStyleFor, isControlLine, isEmptyInitialiser, isVoidType,
  lineCommentsFor, matchLocal, matchLoop,
} from '../src/languageProfiles';

describe('matchLoop', () => {
  const cases: Array<[string, string, string, string]> = [
    ['go two-value range',  'for i, user := range users {',                'user',  'users'],
    ['go one-value range',  'for user := range users {',                   'user',  'users'],
    ['csharp foreach',      'foreach (var user in users) {',               'user',  'users'],
    ['php foreach',         'foreach ($users as $user) {',                 '$user', '$users'],
    ['php foreach kv',      'foreach ($users as $id => $user) {',          '$user', '$users'],
    ['js for-of',           'for (const user of users) {',                 'user',  'users'],
    ['js for-in',           'for (let key in lookup) {',                   'key',   'lookup'],
    ['java enhanced for',   'for (User user : users) {',                   'user',  'users'],
    ['cpp range for',       'for (const auto& user : users) {',            'user',  'users'],
    ['scala for',           'for (user <- users) {',                       'user',  'users'],
    ['python for',          'for user in users:',                          'user',  'users'],
    ['rust for',            'for user in users {',                         'user',  'users'],
    ['kotlin for',          'for (user in users) {',                       'user',  'users'],
    ['ruby each',           'users.each do |user|',                        'user',  'users'],
    ['js forEach',          'users.forEach(user => {',                     'user',  'users'],
  ];

  it.each(cases)('reads %s', (_label, header, binding, iterable) => {
    const m = matchLoop(header);
    expect(m).not.toBeNull();
    expect(m!.binding).toBe(binding);
    expect(m!.iterable).toBe(iterable);
  });

  it('reads a counter loop as a binding with no collection', () => {
    expect(matchLoop('for (let i = 0; i < n; i++) {')).toEqual({ binding: 'i', iterable: '' });
  });

  it('does not read an ordinary call as a loop', () => {
    expect(matchLoop('const total = sum(values);')).toBeNull();
  });
});

describe('matchLocal', () => {
  const cases: Array<[string, string, string, string, string]> = [
    ['ts annotated',   'const names: string[] = [];',          'names',  'string[]',  '[]'],
    ['rust let mut',   'let mut names = Vec::new();',           'names',  '',          'Vec::new()'],
    ['go short decl',  'names := []string{}',                   'names',  '',          '[]string{}'],
    ['go var',         'var names []string',                    'names',  '[]string',  ''],
    ['php',            '$names = [];',                          '$names', '',          '[]'],
    ['java',           'List<String> names = new ArrayList<>();', 'names', 'List<String>', 'new ArrayList<>()'],
    ['cpp no init',    'std::vector<std::string> names;',        'names',  'std::vector<std::string>', ''],
    ['kotlin val',     'val names = mutableListOf<String>()',    'names',  '',          'mutableListOf<String>()'],
    ['python',         'names = []',                            'names',  '',          '[]'],
  ];

  it.each(cases)('reads a %s declaration', (_label, line, name, type, init) => {
    const m = matchLocal(line);
    expect(m).not.toBeNull();
    expect(m!.name).toBe(name);
    expect(m!.type).toBe(type);
    expect(m!.init).toBe(init);
  });

  it('refuses a control-flow header', () => {
    expect(matchLocal('if (total = 0) {')).toBeNull();
    expect(matchLocal('foreach ($users as $user) {')).toBeNull();
  });
});

describe('isEmptyInitialiser', () => {
  const empty = [
    '[]', '[];', '{}', '0', '0.0', "''", '""', 'new ArrayList<>()', 'new Map()',
    'Vec::new()', 'vec![]', 'make(map[string]int)', '[]string{}',
    'mutableListOf<String>()', 'ListBuffer[String]()',
    'scala.collection.mutable.ListBuffer[String]()', 'list()', 'array()',
  ];
  it.each(empty)('treats %s as empty', (init) => {
    expect(isEmptyInitialiser(init)).toBe(true);
  });

  const filled = ['[1, 2]', 'new ArrayList<>(other)', 'fetchUsers()', 'user.name', '42'];
  it.each(filled)('leaves %s alone', (init) => {
    expect(isEmptyInitialiser(init)).toBe(false);
  });

  it('treats a declaration with no initialiser as empty when a type was stated', () => {
    expect(isEmptyInitialiser('', 'std::vector<std::string>')).toBe(true);
    expect(isEmptyInitialiser('', '')).toBe(false);
  });
});

describe('isVoidType', () => {
  it.each(['void', 'Void', 'None', 'Unit', '()', 'undefined', 'never', 'Promise<void>', 'Task<Unit>'])(
    'treats %s as returning nothing', (type) => expect(isVoidType(type)).toBe(true));

  it.each(['string', 'List<User>', 'Promise<Order[]>', 'Result<T, E>'])(
    'treats %s as a real result', (type) => expect(isVoidType(type)).toBe(false));
});

describe('isControlLine', () => {
  it('recognises headers that open a block without declaring anything', () => {
    expect(isControlLine('foreach ($users as $user) {')).toBe(true);
    expect(isControlLine('} catch (IOException e) {')).toBe(true);
    expect(isControlLine('} else if (n > 0) {')).toBe(true);
    expect(isControlLine('using (var stream = File.Open(path)) {')).toBe(true);
  });

  it('leaves real declarations alone', () => {
    expect(isControlLine('public List<String> collectNames(List<User> users) {')).toBe(false);
    expect(isControlLine('function collectNames(users) {')).toBe(false);
  });
});

describe('language identity', () => {
  it('knows how each family delimits a block', () => {
    expect(blockStyleFor('python')).toBe('indent');
    expect(blockStyleFor('ruby')).toBe('end');
    expect(blockStyleFor('typescript')).toBe('brace');
  });

  it('knows the line-comment markers', () => {
    expect(lineCommentsFor('python')).toEqual(['#']);
    expect(lineCommentsFor('lua')).toEqual(['--']);
    expect(lineCommentsFor('rust')).toContain('///');
    expect(lineCommentsFor('typescript')).toEqual(['//']);
  });
});
