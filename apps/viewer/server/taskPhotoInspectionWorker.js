'use strict';
const { browsePhotos, previewPhotos, discoverSiblingSurveys, selectWithSiblingSurvey } = require('./taskPhotoImports');
process.once('message', async input => {
  try {
    const storage = { roots: { dataset_import: input.root }, requireSpace() {} };
    let value;
    if (input.operation === 'browse') value = browsePhotos(storage, input.options);
    else if (input.operation === 'photo_preview') value = await previewPhotos(storage, input.paths, input.maxFiles);
    else if (input.operation === 'survey_preview') value = discoverSiblingSurveys(storage, input.paths, input.maxFiles).map(({relative, sha256}) => ({path:relative,sha256}));
    else if (input.operation === 'select') value = selectWithSiblingSurvey(storage, input.paths, input.survey, input.maxFiles);
    else throw Object.assign(new Error('invalid operation'), {code:'invalid_import_operation'});
    if (process.connected) process.send({ok:true,value}, () => process.exit(0));
  } catch (error) { if (process.connected) process.send({ok:false,code:error.code}, () => process.exit(0)); }
});
