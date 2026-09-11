const { text } = JSON.parse(process.argv[2]);
if (typeof text !== 'string') throw new Error('text must be a string');
process.stdout.write(JSON.stringify({ characters: [...text].length, lines: text.split('\n').length }));
