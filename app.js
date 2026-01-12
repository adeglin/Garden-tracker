fetch('garden_master_full.json')
  .then(r => r.json())
  .then(data => console.log('Loaded data', data))
  .catch(err => console.error('Failed to load data', err));
