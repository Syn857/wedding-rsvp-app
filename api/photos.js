import { put, del } from '@vercel/blob';
import { Redis } from '@upstash/redis';
import formidable from 'formidable';
import fs from 'fs';
import { REDIS_CONFIG, REDIS_KEYS, MESSAGES } from './config/constants.js';
import { error as logError, info as logInfo } from './utils/logger.js';
import { handleError } from './utils/errorHandler.js';
import { rateLimitMiddleware } from './utils/rateLimit.js';

// Initialize Redis client
const redis = new Redis(REDIS_CONFIG);

// Photo upload endpoint
const uploadPhoto = async (req, res) => {
  try {
    // Parse form data with formidable
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024, // 10MB
      allowEmptyFiles: false,
      multiples: false
    });

    const [fields, files] = await form.parse(req);
    
    const photoFile = files.photo?.[0];
    if (!photoFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const guestName = fields.guestName?.[0];
    const eventType = fields.eventType?.[0] || 'wedding';
    
    if (!guestName || !guestName.trim()) {
      return res.status(400).json({ error: 'Guest name is required' });
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(photoFile.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Only JPEG, PNG, and WebP are allowed.' });
    }

    // Validate file size (max 10MB)
    if (photoFile.size > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }

    // Read file buffer
    const fileBuffer = await fs.promises.readFile(photoFile.filepath);

    // Generate unique filename
    const timestamp = Date.now();
    const fileExtension = photoFile.originalFilename?.split('.').pop() || 'jpg';
    const filename = `${guestName.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}.${fileExtension}`;

    logInfo('Starting photo upload', {
      filename,
      size: photoFile.size,
      type: photoFile.mimetype,
      guestName
    });

    // Upload to Vercel Blob
    const blob = await put(filename, fileBuffer, {
      access: 'public',
      contentType: photoFile.mimetype
    });

    // Store metadata in Redis
    const photoData = {
      id: blob.url.split('/').pop(),
      url: blob.url,
      filename: photoFile.originalFilename,
      guestName: guestName.trim(),
      eventType,
      uploadedAt: new Date().toISOString(),
      size: photoFile.size,
      mimetype: photoFile.mimetype
    };

    await redis.lpush(REDIS_KEYS.PHOTOS, JSON.stringify(photoData));
    await redis.incr(REDIS_KEYS.PHOTO_COUNT);

    logInfo('Photo uploaded successfully', {
      photoId: photoData.id,
      url: blob.url,
      guestName
    });

    // Clean up temporary file
    try {
      await fs.promises.unlink(photoFile.filepath);
    } catch (cleanupError) {
      logError('Failed to cleanup temporary file', { 
        filepath: photoFile.filepath, 
        error: cleanupError.message 
      });
    }

    res.status(200).json({
      success: true,
      message: MESSAGES.PHOTO_UPLOAD_SUCCESS,
      photo: photoData
    });

  } catch (error) {
    logError('Photo upload failed', { 
      error: error.message, 
      stack: error.stack 
    });
    return handleError(error, res, { context: 'uploadPhoto' });
  }
};

// Get photos endpoint
const getPhotos = async (req, res) => {
  try {
    const photos = await redis.lrange(REDIS_KEYS.PHOTOS, 0, -1);
    const parsedPhotos = photos.map(photo => JSON.parse(photo));
    
    res.status(200).json({
      success: true,
      photos: parsedPhotos,
      count: parsedPhotos.length
    });
  } catch (error) {
    logError('Failed to fetch photos', { error: error.message });
    return handleError(error, res, { context: 'getPhotos' });
  }
};

// Delete photo endpoint
const deletePhoto = async (req, res) => {
  try {
    const { photoId } = req.body;
    
    if (!photoId) {
      return res.status(400).json({ error: 'Photo ID is required' });
    }

    // Get all photos
    const photos = await redis.lrange(REDIS_KEYS.PHOTOS, 0, -1);
    const photoIndex = photos.findIndex(photo => {
      const parsed = JSON.parse(photo);
      return parsed.id === photoId || parsed.url.includes(photoId);
    });

    if (photoIndex === -1) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    const photoData = JSON.parse(photos[photoIndex]);

    // Delete from Vercel Blob
    try {
      await del(photoData.url);
    } catch (blobError) {
      logError('Failed to delete from blob storage', { 
        url: photoData.url, 
        error: blobError.message 
      });
    }

    // Remove from Redis
    await redis.lrem(REDIS_KEYS.PHOTOS, 1, photos[photoIndex]);
    await redis.decr(REDIS_KEYS.PHOTO_COUNT);

    logInfo('Photo deleted successfully', {
      photoId,
      url: photoData.url
    });

    res.status(200).json({
      success: true,
      message: 'Photo deleted successfully'
    });

  } catch (error) {
    logError('Photo deletion failed', { error: error.message });
    return handleError(error, res, { context: 'deletePhoto' });
  }
};

// Clear all photos endpoint (admin only)
const clearAllPhotos = async (req, res) => {
  try {
    // Get all photos first
    const photos = await redis.lrange(REDIS_KEYS.PHOTOS, 0, -1);
    
    // Delete each photo from blob storage
    for (const photo of photos) {
      try {
        const photoData = JSON.parse(photo);
        await del(photoData.url);
      } catch (blobError) {
        logError('Failed to delete photo from blob', { error: blobError.message });
      }
    }

    // Clear Redis data
    await redis.del(REDIS_KEYS.PHOTOS);
    await redis.del(REDIS_KEYS.PHOTO_COUNT);

    logInfo('All photos cleared successfully');

    res.status(200).json({
      success: true,
      message: 'All photos cleared successfully',
      deletedCount: photos.length
    });

  } catch (error) {
    logError('Failed to clear all photos', { error: error.message });
    return handleError(error, res, { context: 'clearAllPhotos' });
  }
};

// Main API handler for Vercel
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    switch (req.method) {
      case 'GET':
        return await getPhotos(req, res);
      case 'POST':
        return await uploadPhoto(req, res);
      case 'DELETE':
        return await deletePhoto(req, res);
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    logError('API handler error', { 
      method: req.method, 
      error: error.message 
    });
    return handleError(error, res, { context: 'apiHandler' });
  }
}

// Export individual functions for dev server
export { uploadPhoto, getPhotos, deletePhoto, clearAllPhotos };